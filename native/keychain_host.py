#!/usr/bin/env python3
"""Motion's deliberately small Native Messaging key-vault companion.

The host accepts only protocol version 1 frames and two fixed provider IDs. It
never accepts a command, URL, file path, or vault name from the extension.
"""
from __future__ import annotations

import ctypes
import json
import os
import struct
import subprocess
import sys
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Final

HOST_NAME: Final = "com.motion.keychain"
PROTOCOL_VERSION: Final = 1
PROVIDERS: Final = frozenset(("openai", "anthropic"))
MAX_FRAME_BYTES: Final = 16_384
MAX_KEY_BYTES: Final = 4_096
SERVICE_NAME: Final = "com.motion.keychain.v1"
ORIGIN_RE: Final = re.compile(r"^chrome-extension://[a-p]{32}/$")


class VaultError(Exception):
    """Expected vault failure that can be represented without OS diagnostics."""

    code: str = "vault-unavailable"


class VaultLocked(VaultError):
    code = "vault-locked"


class VaultUnavailable(VaultError):
    code = "vault-unavailable"


class InvalidFrame(Exception):
    pass


@dataclass(frozen=True)
class Request:
    operation: str
    provider_id: str
    key: str | None = None


class Vault(ABC):
    backend: str

    @abstractmethod
    def get(self, provider_id: str) -> str | None:
        raise NotImplementedError

    @abstractmethod
    def set(self, provider_id: str, key: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def delete(self, provider_id: str) -> None:
        raise NotImplementedError


class UnavailableVault(Vault):
    """Keeps protocol failures framed when no OS backend can start."""

    backend = "unavailable"

    def get(self, provider_id: str) -> str | None:
        raise VaultUnavailable()

    def set(self, provider_id: str, key: str) -> None:
        raise VaultUnavailable()

    def delete(self, provider_id: str) -> None:
        raise VaultUnavailable()


def parse_request(payload: object) -> Request:
    if not isinstance(payload, dict):
        raise ValueError("object required")
    operation = payload.get("operation")
    provider_id = payload.get("providerId")
    if payload.get("version") != PROTOCOL_VERSION or isinstance(payload.get("version"), bool):
        raise ValueError("unsupported version")
    if operation not in {"status", "get", "set", "delete"}:
        raise ValueError("unsupported operation")
    if provider_id not in PROVIDERS:
        raise ValueError("unsupported provider")
    expected_fields = {"version", "operation", "providerId"}
    if operation == "set":
        expected_fields.add("key")
        key = payload.get("key")
        if not isinstance(key, str) or not key or len(key.encode("utf-8")) > MAX_KEY_BYTES:
            raise ValueError("invalid key")
    else:
        key = None
    if set(payload) != expected_fields:
        raise ValueError("unexpected field")
    return Request(operation=operation, provider_id=provider_id, key=key)


def success(vault: Vault, **fields: object) -> dict[str, object]:
    return {"version": PROTOCOL_VERSION, "ok": True, "backend": vault.backend, **fields}


def failure(code: str) -> dict[str, object]:
    # Native-messaging output is a protocol boundary. Deliberately never put an
    # exception message, OS error, request payload, or secret in this object.
    return {"version": PROTOCOL_VERSION, "ok": False, "code": code}


def dispatch(payload: object, vault: Vault) -> dict[str, object]:
    try:
        request = parse_request(payload)
    except (TypeError, ValueError, UnicodeError):
        return failure("invalid-request")
    try:
        if request.operation == "status":
            return success(vault, present=vault.get(request.provider_id) is not None)
        if request.operation == "get":
            key = vault.get(request.provider_id)
            return success(vault, key=key, present=key is not None)
        if request.operation == "set":
            assert request.key is not None
            vault.set(request.provider_id, request.key)
            return success(vault, present=True)
        vault.delete(request.provider_id)
        return success(vault, present=False)
    except VaultError as error:
        return failure(error.code)
    except Exception:
        # The host must be safe even if an unexpected platform binding fails.
        return failure("vault-unavailable")


def read_exact(stream: BinaryIO, length: int) -> bytes:
    parts: list[bytes] = []
    remaining = length
    while remaining:
        part = stream.read(remaining)
        if not part:
            raise InvalidFrame("truncated frame")
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def read_frame(stream: BinaryIO) -> object | None:
    header = stream.read(4)
    if header == b"":
        return None
    if len(header) != 4:
        raise InvalidFrame("truncated frame header")
    length = struct.unpack("<I", header)[0]
    if length == 0 or length > MAX_FRAME_BYTES:
        raise InvalidFrame("invalid frame length")
    try:
        return json.loads(read_exact(stream, length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidFrame("invalid JSON") from error


def write_frame(stream: BinaryIO, payload: dict[str, object]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_FRAME_BYTES:
        # All response shapes are fixed and much smaller. Never serialize an
        # unexpected large payload across the native boundary.
        encoded = b'{"version":1,"ok":false,"code":"vault-unavailable"}'
    stream.write(struct.pack("<I", len(encoded)))
    stream.write(encoded)
    stream.flush()


def serve(input_stream: BinaryIO, output_stream: BinaryIO, vault: Vault) -> None:
    while True:
        try:
            payload = read_frame(input_stream)
        except InvalidFrame:
            write_frame(output_stream, failure("invalid-request"))
            return
        if payload is None:
            return
        write_frame(output_stream, dispatch(payload, vault))


class MacOSKeychainVault(Vault):
    """Generic-password Keychain backend using Security.framework directly."""

    backend = "macos-keychain"
    _ERR_ITEM_NOT_FOUND: Final = -25300
    _ERR_DUPLICATE_ITEM: Final = -25299
    _ERR_INTERACTION_NOT_ALLOWED: Final = -25308
    _ERR_AUTH_FAILED: Final = -25293

    def __init__(self) -> None:
        if sys.platform != "darwin":
            raise VaultUnavailable()
        try:
            self.security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
            self.core_foundation = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        except OSError as error:
            raise VaultUnavailable() from error
        self._configure_bindings()

    def _configure_bindings(self) -> None:
        self.security.SecKeychainAddGenericPassword.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32,
            ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ]
        self.security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        self.security.SecKeychainFindGenericPassword.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32,
            ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        self.security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.security.SecKeychainItemFreeContent.restype = ctypes.c_int32
        self.security.SecKeychainItemDelete.argtypes = [ctypes.c_void_p]
        self.security.SecKeychainItemDelete.restype = ctypes.c_int32
        self.security.SecKeychainItemModifyContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
        self.security.SecKeychainItemModifyContent.restype = ctypes.c_int32
        self.core_foundation.CFRelease.argtypes = [ctypes.c_void_p]
        self.core_foundation.CFRelease.restype = None

    @classmethod
    def _check(cls, status: int) -> None:
        if status == 0:
            return
        if status in {cls._ERR_INTERACTION_NOT_ALLOWED, cls._ERR_AUTH_FAILED}:
            raise VaultLocked()
        raise VaultUnavailable()

    @staticmethod
    def _encoded(provider_id: str) -> tuple[bytes, bytes]:
        return SERVICE_NAME.encode("utf-8"), provider_id.encode("utf-8")

    def _find(self, provider_id: str, include_secret: bool) -> tuple[ctypes.c_void_p, bytes | None] | None:
        service, account = self._encoded(provider_id)
        secret_length = ctypes.c_uint32()
        secret_ptr = ctypes.c_void_p()
        item = ctypes.c_void_p()
        status = self.security.SecKeychainFindGenericPassword(
            None, len(service), service, len(account), account,
            ctypes.byref(secret_length) if include_secret else None,
            ctypes.byref(secret_ptr) if include_secret else None,
            ctypes.byref(item),
        )
        if status == self._ERR_ITEM_NOT_FOUND:
            return None
        self._check(status)
        secret: bytes | None = None
        try:
            if include_secret:
                secret = ctypes.string_at(secret_ptr, secret_length.value)
        finally:
            if include_secret and secret_ptr.value:
                self.security.SecKeychainItemFreeContent(None, secret_ptr)
        return item, secret

    def get(self, provider_id: str) -> str | None:
        found = self._find(provider_id, include_secret=True)
        if found is None:
            return None
        item, secret = found
        try:
            return (secret or b"").decode("utf-8")
        except UnicodeDecodeError as error:
            raise VaultUnavailable() from error
        finally:
            self.core_foundation.CFRelease(item)

    def set(self, provider_id: str, key: str) -> None:
        service, account = self._encoded(provider_id)
        secret = key.encode("utf-8")
        secret_buffer = ctypes.create_string_buffer(secret)
        status = self.security.SecKeychainAddGenericPassword(
            None, len(service), service, len(account), account,
            len(secret), secret_buffer, None,
        )
        if status != self._ERR_DUPLICATE_ITEM:
            self._check(status)
            return
        found = self._find(provider_id, include_secret=False)
        if found is None:
            raise VaultUnavailable()
        item, _ = found
        try:
            self._check(self.security.SecKeychainItemModifyContent(item, None, len(secret), secret_buffer))
        finally:
            self.core_foundation.CFRelease(item)

    def delete(self, provider_id: str) -> None:
        found = self._find(provider_id, include_secret=False)
        if found is None:
            return
        item, _ = found
        try:
            self._check(self.security.SecKeychainItemDelete(item))
        finally:
            self.core_foundation.CFRelease(item)


class FileTime(ctypes.Structure):
    """Win32 FILETIME is two DWORDs, with 4-byte field alignment."""

    _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]


class CredentialW(ctypes.Structure):
    """Exact CREDENTIALW layout used by Credential Manager on 32/64-bit Windows."""

    _fields_ = [
        ("Flags", ctypes.c_uint32), ("Type", ctypes.c_uint32), ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p), ("LastWritten", FileTime), ("CredentialBlobSize", ctypes.c_uint32),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)), ("Persist", ctypes.c_uint32),
        ("AttributeCount", ctypes.c_uint32), ("Attributes", ctypes.c_void_p), ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


class WindowsCredentialVault(Vault):
    """Per-user Generic Credential backend; no shell or command arguments."""

    backend = "windows-credential-manager"
    _CRED_TYPE_GENERIC: Final = 1
    _CRED_PERSIST_LOCAL_MACHINE: Final = 2
    _ERROR_NOT_FOUND: Final = 1168
    _ERROR_CANCELLED: Final = 1223

    def __init__(self) -> None:
        if os.name != "nt":
            raise VaultUnavailable()
        self._credential_type = CredentialW
        self.advapi = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        self.advapi.CredReadW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.POINTER(CredentialW))]
        self.advapi.CredReadW.restype = ctypes.c_bool
        self.advapi.CredWriteW.argtypes = [ctypes.POINTER(CredentialW), ctypes.c_uint32]
        self.advapi.CredWriteW.restype = ctypes.c_bool
        self.advapi.CredDeleteW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
        self.advapi.CredDeleteW.restype = ctypes.c_bool
        self.advapi.CredFree.argtypes = [ctypes.c_void_p]

    def _target(self, provider_id: str) -> str:
        return f"{SERVICE_NAME}/{provider_id}"

    def _error(self) -> VaultError:
        return VaultLocked() if ctypes.get_last_error() == self._ERROR_CANCELLED else VaultUnavailable()

    def get(self, provider_id: str) -> str | None:
        credential = ctypes.POINTER(self._credential_type)()
        if not self.advapi.CredReadW(self._target(provider_id), self._CRED_TYPE_GENERIC, 0, ctypes.byref(credential)):
            if ctypes.get_last_error() == self._ERROR_NOT_FOUND:
                return None
            raise self._error()
        try:
            blob = ctypes.string_at(credential.contents.CredentialBlob, credential.contents.CredentialBlobSize)
            return blob.decode("utf-8")
        except UnicodeDecodeError as error:
            raise VaultUnavailable() from error
        finally:
            self.advapi.CredFree(credential)

    def set(self, provider_id: str, key: str) -> None:
        secret = key.encode("utf-8")
        buffer = (ctypes.c_byte * len(secret)).from_buffer_copy(secret)
        credential = self._credential_type(
            0, self._CRED_TYPE_GENERIC, self._target(provider_id), None, 0, len(secret), buffer,
            self._CRED_PERSIST_LOCAL_MACHINE, 0, None, None, None,
        )
        if not self.advapi.CredWriteW(ctypes.byref(credential), 0):
            raise self._error()

    def delete(self, provider_id: str) -> None:
        if not self.advapi.CredDeleteW(self._target(provider_id), self._CRED_TYPE_GENERIC, 0):
            if ctypes.get_last_error() == self._ERROR_NOT_FOUND:
                return
            raise self._error()


class LinuxSecretServiceVault(Vault):
    """Secret Service through the fixed system secret-tool binary."""

    backend = "linux-secret-service"

    def __init__(self) -> None:
        if not sys.platform.startswith("linux"):
            raise VaultUnavailable()
        for candidate in (Path("/usr/bin/secret-tool"), Path("/bin/secret-tool")):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                self.secret_tool = str(candidate.resolve())
                break
        else:
            raise VaultUnavailable()

    def _run(self, action: str, provider_id: str, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
        # All argv values are fixed constants or checked provider IDs. A secret
        # is only ever provided through stdin for `store`, never argv/env/logs.
        commands = {
            "lookup": [self.secret_tool, "lookup", "service", SERVICE_NAME, "provider", provider_id],
            "store": [self.secret_tool, "store", "--label=Motion API key", "service", SERVICE_NAME, "provider", provider_id],
            "clear": [self.secret_tool, "clear", "service", SERVICE_NAME, "provider", provider_id],
        }
        try:
            return subprocess.run(
                commands[action], input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                check=False, timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise VaultUnavailable() from error

    def get(self, provider_id: str) -> str | None:
        completed = self._run("lookup", provider_id)
        # `secret-tool lookup` uses exit 1 with no diagnostic for a missing
        # item. Treat that as absent, while retaining diagnostics privately to
        # distinguish an unavailable/locked service without ever returning it.
        if completed.returncode == 1 and not completed.stderr:
            return None
        if completed.returncode != 0:
            raise VaultUnavailable()
        value = completed.stdout.rstrip(b"\n")
        if not value:
            return None
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as error:
            raise VaultUnavailable() from error

    def set(self, provider_id: str, key: str) -> None:
        completed = self._run("store", provider_id, key.encode("utf-8"))
        if completed.returncode != 0:
            raise VaultUnavailable()

    def delete(self, provider_id: str) -> None:
        completed = self._run("clear", provider_id)
        if completed.returncode == 1 and not completed.stderr:
            return
        if completed.returncode != 0:
            raise VaultUnavailable()


def create_platform_vault() -> Vault:
    if sys.platform == "darwin":
        return MacOSKeychainVault()
    if os.name == "nt":
        return WindowsCredentialVault()
    if sys.platform.startswith("linux"):
        return LinuxSecretServiceVault()
    raise VaultUnavailable()


def caller_origin_is_allowed(arguments: list[str]) -> bool:
    """Checks Chrome's first host argument against the installer-fixed origin."""
    if len(arguments) < 3 or arguments[0] != "--allowed-origin":
        return False
    expected_origin, caller_origin = arguments[1], arguments[2]
    if not ORIGIN_RE.fullmatch(expected_origin) or caller_origin != expected_origin:
        return False
    # Chrome adds only this documented Windows handle argument. Reject every
    # other argument so the wrapper cannot become a general command runner.
    return all(re.fullmatch(r"--parent-window=\d+", argument) for argument in arguments[3:])


def main(arguments: list[str] | None = None) -> int:
    if not caller_origin_is_allowed(sys.argv[1:] if arguments is None else arguments):
        return 1
    try:
        vault = create_platform_vault()
    except VaultError:
        # Keep a valid caller's status/get/set/delete response inside the
        # protocol even when a platform facility (such as Secret Service) is
        # absent. No diagnostic reaches stdout or stderr.
        vault = UnavailableVault()
    serve(sys.stdin.buffer, sys.stdout.buffer, vault)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
