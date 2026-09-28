from __future__ import annotations

import io
import json
import os
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NATIVE))
import install  # noqa: E402
import keychain_host as host  # noqa: E402
import package as package_companion  # noqa: E402


class SyntheticMacVault(host.Vault):
    """Synthetic vault used to prove macOS protocol semantics without a key."""

    backend = "macos-keychain"

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get(self, provider_id: str) -> str | None:
        return self.values.get(provider_id)

    def set(self, provider_id: str, key: str) -> None:
        self.values[provider_id] = key

    def delete(self, provider_id: str) -> None:
        self.values.pop(provider_id, None)


class LockedVault(SyntheticMacVault):
    def get(self, provider_id: str) -> str | None:
        raise host.VaultLocked()


def frame(payload: object) -> bytes:
    raw = json.dumps(payload).encode("utf-8")
    return struct.pack("<I", len(raw)) + raw


def responses(raw: bytes, vault: host.Vault) -> list[dict[str, object]]:
    output = io.BytesIO()
    host.serve(io.BytesIO(raw), output, vault)
    output.seek(0)
    result: list[dict[str, object]] = []
    while header := output.read(4):
        length = struct.unpack("<I", header)[0]
        result.append(json.loads(output.read(length)))
    return result


class KeychainHostTests(unittest.TestCase):
    def test_synthetic_macos_set_get_delete_uses_only_framed_protocol(self) -> None:
        vault = SyntheticMacVault()
        reply = responses(
            b"".join((
                frame({"version": 1, "operation": "set", "providerId": "openai", "key": "synthetic-key"}),
                frame({"version": 1, "operation": "get", "providerId": "openai"}),
                frame({"version": 1, "operation": "delete", "providerId": "openai"}),
                frame({"version": 1, "operation": "status", "providerId": "openai"}),
            )),
            vault,
        )
        self.assertEqual(reply, [
            {"version": 1, "ok": True, "backend": "macos-keychain", "present": True},
            {"version": 1, "ok": True, "backend": "macos-keychain", "key": "synthetic-key", "present": True},
            {"version": 1, "ok": True, "backend": "macos-keychain", "present": False},
            {"version": 1, "ok": True, "backend": "macos-keychain", "present": False},
        ])

    def test_invalid_input_and_truncated_or_oversized_frames_do_not_echo_payload(self) -> None:
        canary = "synthetic-secret-not-to-echo"
        invalid = responses(frame({"version": 1, "operation": "get", "providerId": "openai", "key": canary}), SyntheticMacVault())
        malformed = responses(struct.pack("<I", host.MAX_FRAME_BYTES + 1), SyntheticMacVault())
        self.assertEqual(invalid, [{"version": 1, "ok": False, "code": "invalid-request"}])
        self.assertEqual(malformed, [{"version": 1, "ok": False, "code": "invalid-request"}])
        self.assertNotIn(canary, json.dumps(invalid))

    def test_vault_errors_have_only_the_documented_code(self) -> None:
        reply = responses(frame({"version": 1, "operation": "status", "providerId": "anthropic"}), LockedVault())
        self.assertEqual(reply, [{"version": 1, "ok": False, "code": "vault-locked"}])

    def test_missing_platform_backend_still_returns_a_framed_unavailable_reply(self) -> None:
        reply = responses(frame({"version": 1, "operation": "status", "providerId": "anthropic"}), host.UnavailableVault())
        self.assertEqual(reply, [{"version": 1, "ok": False, "code": "vault-unavailable"}])

    def test_linux_secret_service_missing_entries_are_absent_and_keys_only_use_stdin(self) -> None:
        vault = object.__new__(host.LinuxSecretServiceVault)
        vault.secret_tool = "/usr/bin/secret-tool"
        calls: list[tuple[object, object]] = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs.get("input")))
            if argv[1] in {"lookup", "clear"}:
                return host.subprocess.CompletedProcess(argv, 1, b"", b"")
            return host.subprocess.CompletedProcess(argv, 0, b"", b"")

        with patch.object(host.subprocess, "run", side_effect=run):
            self.assertIsNone(vault.get("openai"))
            vault.delete("openai")
            vault.set("openai", "synthetic-key")

        self.assertEqual(calls[0][0], ["/usr/bin/secret-tool", "lookup", "service", host.SERVICE_NAME, "provider", "openai"])
        self.assertEqual(calls[1][0], ["/usr/bin/secret-tool", "clear", "service", host.SERVICE_NAME, "provider", "openai"])
        self.assertEqual(calls[2][0], ["/usr/bin/secret-tool", "store", "--label=Motion API key", "service", host.SERVICE_NAME, "provider", "openai"])
        self.assertEqual(calls[2][1], b"synthetic-key")
        self.assertNotIn("synthetic-key", calls[2][0])

    def test_windows_credential_layout_uses_win32_filetime(self) -> None:
        fields = dict(host.CredentialW._fields_)
        self.assertIs(fields["LastWritten"], host.FileTime)
        self.assertEqual(host.FileTime._fields_, [("dwLowDateTime", host.ctypes.c_uint32), ("dwHighDateTime", host.ctypes.c_uint32)])

    def test_host_accepts_only_the_installer_configured_chrome_origin(self) -> None:
        origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        self.assertTrue(host.caller_origin_is_allowed(["--allowed-origin", origin, origin]))
        self.assertFalse(host.caller_origin_is_allowed(["--allowed-origin", origin, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/"]))
        self.assertFalse(host.caller_origin_is_allowed(["--allowed-origin", origin, origin, "--unexpected=1"]))


class InstallerTests(unittest.TestCase):
    def test_installer_requires_exact_origin_and_emits_one_allowlisted_origin(self) -> None:
        extension_id = "abcdefghijklmnopabcdefghijklmnop"
        origin = install.expected_origin(extension_id)
        install.validate_configuration(extension_id, origin)
        with self.assertRaises(ValueError):
            install.validate_configuration(extension_id, "chrome-extension://abcdefghijklmnopabcdefghijklmnop")
        with self.assertRaises(ValueError):
            install.validate_configuration("not-an-extension-id", origin)
        manifest = install.native_manifest(Path("/absolute/fixed-wrapper"), origin)
        self.assertEqual(manifest["allowed_origins"], [origin])
        self.assertEqual(manifest["path"], "/absolute/fixed-wrapper")

    def test_profile_dir_requires_one_absolute_chrome_user_data_directory(self) -> None:
        with self.assertRaises(ValueError):
            install.profile_path("relative-profile", ("chrome",))
        with self.assertRaises(ValueError):
            install.profile_path("/tmp/profile", ("chrome", "brave"))
        self.assertEqual(install.profile_path("/tmp/profile", ("chrome",)), Path("/tmp/profile").resolve())

    def test_registration_state_retains_shared_host_until_other_browser_manifest_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chrome = Path("/tmp/chrome/NativeMessagingHosts/com.motion.keychain.json")
            brave = Path("/tmp/brave/NativeMessagingHosts/com.motion.keychain.json")
            origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
            install.write_registered_manifest_paths(root, {chrome, brave}, origin)
            remaining = install.registered_manifest_paths(root) - {chrome}
            install.write_registered_manifest_paths(root, remaining, origin)
            self.assertEqual(install.registered_manifest_paths(root), {brave})

    @unittest.skipIf(os.name == "nt", "Windows install uses HKCU and needs a dedicated registry integration test")
    def test_isolated_chrome_install_and_uninstall_use_only_the_requested_directories(self) -> None:
        extension_id = "abcdefghijklmnopabcdefghijklmnop"
        origin = install.expected_origin(extension_id)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile = root / "chrome-user-data"
            companion = root / "companion"
            install.install(extension_id, origin, ("chrome",), str(profile), str(companion))
            manifest_path = profile / "NativeMessagingHosts" / "com.motion.keychain.json"
            manifest = json.loads(manifest_path.read_text())
            self.assertEqual(manifest["allowed_origins"], [origin])
            self.assertTrue(Path(manifest["path"]).is_absolute())
            if os.name != "nt":
                self.assertEqual((companion / "keychain_host.py").stat().st_mode & 0o777, 0o600)
                self.assertEqual((companion / "motion-keychain-host").stat().st_mode & 0o777, 0o700)
            install.uninstall(extension_id, origin, ("chrome",), str(profile), str(companion))
            self.assertFalse(manifest_path.exists())
            self.assertFalse((companion / "keychain_host.py").exists())

    def test_packager_contains_source_and_docs_without_registration_or_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = package_companion.package(Path(temporary) / package_companion.ARCHIVE_NAME)
            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())
        self.assertEqual(names, {
            "native/keychain_host.py", "native/install.py", "native/README.md", "docs/keychain-companion.md",
        })


if __name__ == "__main__":
    unittest.main()
