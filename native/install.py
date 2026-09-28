#!/usr/bin/env python3
"""Install or remove Motion's per-user Native Messaging keychain companion."""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import stat
import sys
from pathlib import Path

HOST_NAME = "com.motion.keychain"
EXTENSION_ID_RE = re.compile(r"^[a-p]{32}$")
BROWSERS = ("chrome", "chromium", "brave")
REGISTRATION_STATE = "registrations.json"


def expected_origin(extension_id: str) -> str:
    return f"chrome-extension://{extension_id}/"


def validate_configuration(extension_id: str, allowed_origin: str) -> None:
    if not EXTENSION_ID_RE.fullmatch(extension_id):
        raise ValueError("--extension-id must be exactly 32 lowercase characters a through p")
    if allowed_origin != expected_origin(extension_id):
        raise ValueError("--allowed-origin must exactly match the supplied extension ID")


def install_root(override: str | None = None) -> Path:
    if override is not None:
        path = Path(override).expanduser()
        if not path.is_absolute():
            raise ValueError("--install-dir must be an absolute path")
        return path.resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Motion" / "keychain-companion"
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if not local_app_data:
            raise RuntimeError("LOCALAPPDATA is unavailable")
        return Path(local_app_data) / "Motion" / "keychain-companion"
    return Path.home() / ".local" / "share" / "motion" / "keychain-companion"


def manifest_dirs(browser: str, profile_dir: Path | None = None) -> tuple[Path, ...]:
    if profile_dir is not None:
        if browser != "chrome":
            raise ValueError("--profile-dir is supported only with --browser chrome")
        return (profile_dir / "NativeMessagingHosts",)
    if sys.platform == "darwin":
        names = {
            "chrome": ("Google", "Chrome"),
            "chromium": ("Chromium",),
            "brave": ("BraveSoftware", "Brave-Browser"),
        }
        return (Path.home() / "Library" / "Application Support" / Path(*names[browser]) / "NativeMessagingHosts",)
    if os.name == "nt":
        # Windows Native Messaging registration is per-user registry state,
        # handled separately in write_windows_registration.
        return ()
    names = {
        "chrome": ("google-chrome",),
        "chromium": ("chromium",),
        "brave": ("BraveSoftware", "Brave-Browser"),
    }
    return (Path.home() / ".config" / Path(*names[browser]) / "NativeMessagingHosts",)


def mode(path: Path, permissions: int) -> None:
    if os.name != "nt":
        path.chmod(permissions)


def native_manifest(wrapper: Path, allowed_origin: str) -> dict[str, object]:
    return {
        "name": HOST_NAME,
        "description": "Motion optional OS keychain companion",
        "path": str(wrapper),
        "type": "stdio",
        # Chrome validates the requesting extension origin before it starts the
        # host. Exactly one derived origin prevents a wildcard or second ID.
        "allowed_origins": [allowed_origin],
    }


def write_wrapper(root: Path, host: Path, allowed_origin: str) -> Path:
    interpreter = Path(sys.executable).resolve()
    if not interpreter.is_absolute() or not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise RuntimeError("the installer requires an absolute executable Python interpreter")
    if os.name == "nt":
        wrapper = root / "motion-keychain-host.cmd"
        wrapper.write_text(f'@echo off\r\n"{interpreter}" "{host}" --allowed-origin "{allowed_origin}" %*\r\n', encoding="utf-8", newline="")
    else:
        wrapper = root / "motion-keychain-host"
        # Quote every installer-derived value for POSIX shell. Double quotes
        # alone leave command substitutions in a path active at launch time.
        command = " ".join((
            "exec", shlex.quote(str(interpreter)), shlex.quote(str(host)),
            "--allowed-origin", shlex.quote(allowed_origin), '"$@"',
        ))
        wrapper.write_text(f"#!/bin/sh\n{command}\n", encoding="utf-8")
        mode(wrapper, 0o700)
    return wrapper


def copy_host(root: Path) -> Path:
    source = Path(__file__).with_name("keychain_host.py")
    destination = root / "keychain_host.py"
    shutil.copyfile(source, destination)
    mode(destination, 0o600)
    return destination


def registration_state_path(root: Path) -> Path:
    return root / REGISTRATION_STATE


def registered_manifest_paths(root: Path) -> set[Path]:
    """Read only paths the installer previously wrote; never delete from it."""
    try:
        raw = json.loads(registration_state_path(root).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    values = raw.get("manifestPaths") if isinstance(raw, dict) else None
    if not isinstance(values, list):
        return set()
    return {Path(value) for value in values if isinstance(value, str) and Path(value).is_absolute()}


def registered_allowed_origin(root: Path) -> str | None:
    try:
        raw = json.loads(registration_state_path(root).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return raw.get("allowedOrigin") if isinstance(raw, dict) and isinstance(raw.get("allowedOrigin"), str) else None


def write_registered_manifest_paths(root: Path, paths: set[Path], allowed_origin: str) -> None:
    state = registration_state_path(root)
    if not paths:
        state.unlink(missing_ok=True)
        return
    state.write_text(json.dumps({
        "allowedOrigin": allowed_origin,
        "manifestPaths": sorted(str(path) for path in paths),
    }, indent=2) + "\n", encoding="utf-8")
    mode(state, 0o600)


def write_windows_registration(browser: str, manifest: Path) -> None:
    import winreg  # Available only when os.name == "nt".
    browser_key = {
        "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
        "chromium": r"Software\Chromium\NativeMessagingHosts",
        "brave": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    }[browser]
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, f"{browser_key}\\{HOST_NAME}", 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))


def remove_windows_registration(browser: str) -> None:
    import winreg
    browser_key = {
        "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
        "chromium": r"Software\Chromium\NativeMessagingHosts",
        "brave": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    }[browser]
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{browser_key}\\{HOST_NAME}")
    except FileNotFoundError:
        pass


def profile_path(profile_dir: str | None, browsers: tuple[str, ...]) -> Path | None:
    if profile_dir is None:
        return None
    if browsers != ("chrome",):
        raise ValueError("--profile-dir requires exactly --browser chrome")
    path = Path(profile_dir).expanduser()
    if not path.is_absolute():
        raise ValueError("--profile-dir must be an absolute Chrome user-data directory")
    return path.resolve()


def install(extension_id: str, allowed_origin: str, browsers: tuple[str, ...], profile_dir: str | None = None, install_dir: str | None = None) -> None:
    validate_configuration(extension_id, allowed_origin)
    root = install_root(install_dir)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode(root, 0o700)
    existing_paths = registered_manifest_paths(root)
    existing_origin = registered_allowed_origin(root)
    if existing_paths and existing_origin not in {None, allowed_origin}:
        raise ValueError("remove existing companion registrations before installing for a different extension ID")
    wrapper = write_wrapper(root, copy_host(root), allowed_origin)
    isolated_profile = profile_path(profile_dir, browsers)
    manifest = native_manifest(wrapper, allowed_origin)
    # Re-validate the generated document before writing it. The same precise
    # origin is therefore the command's explicit input and Chrome's authority.
    if manifest["allowed_origins"] != [expected_origin(extension_id)]:
        raise RuntimeError("generated allowed origin did not match the extension ID")
    written_paths: set[Path] = set()
    for browser in browsers:
        if os.name == "nt":
            manifest_path = root / f"{browser}-{HOST_NAME}.json"
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            mode(manifest_path, 0o600)
            write_windows_registration(browser, manifest_path)
            written_paths.add(manifest_path)
        else:
            for directory in manifest_dirs(browser, isolated_profile):
                directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                mode(directory, 0o700)
                manifest_path = directory / f"{HOST_NAME}.json"
                manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
                mode(manifest_path, 0o600)
                written_paths.add(manifest_path)
    write_registered_manifest_paths(root, existing_paths | written_paths, allowed_origin)


def uninstall(extension_id: str, allowed_origin: str, browsers: tuple[str, ...], profile_dir: str | None = None, install_dir: str | None = None) -> None:
    validate_configuration(extension_id, allowed_origin)
    root = install_root(install_dir)
    isolated_profile = profile_path(profile_dir, browsers)
    removed_paths: set[Path] = set()
    for browser in browsers:
        if os.name == "nt":
            remove_windows_registration(browser)
            manifest_path = root / f"{browser}-{HOST_NAME}.json"
            manifest_path.unlink(missing_ok=True)
            removed_paths.add(manifest_path)
        else:
            for directory in manifest_dirs(browser, isolated_profile):
                manifest_path = directory / f"{HOST_NAME}.json"
                manifest_path.unlink(missing_ok=True)
                removed_paths.add(manifest_path)
    origin = registered_allowed_origin(root) or allowed_origin
    remaining_paths = registered_manifest_paths(root) - removed_paths
    write_registered_manifest_paths(root, remaining_paths, origin)
    if remaining_paths:
        # Chrome/Chromium/Brave registrations share one wrapper. Removing it
        # here would leave the other selected browser registrations pointing
        # at a missing executable. Retain only this keyless local program.
        return
    # No secret is in this directory. Removing the companion must not remove
    # the user's Keychain/Credential Manager/Secret Service entry.
    for item in (root / "motion-keychain-host", root / "motion-keychain-host.cmd", root / "keychain_host.py"):
        item.unlink(missing_ok=True)
    try:
        root.rmdir()
    except OSError:
        pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Motion's optional keychain companion for one extension ID.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--install", action="store_true")
    action.add_argument("--uninstall", action="store_true")
    parser.add_argument("--extension-id", required=True, help="32-character Chrome extension ID (a-p only)")
    parser.add_argument("--allowed-origin", help="optional explicit origin; must equal chrome-extension://EXTENSION_ID/")
    parser.add_argument("--browser", action="append", choices=BROWSERS, default=[], help="repeat for a single browser; default installs all supported browsers")
    parser.add_argument("--profile-dir", help="absolute Chrome user-data directory for an isolated Chrome 146+ profile")
    parser.add_argument("--install-dir", help="absolute companion directory; useful for isolated test installs")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    browsers = tuple(args.browser) or BROWSERS
    allowed_origin = args.allowed_origin or expected_origin(args.extension_id)
    try:
        if args.install:
            install(args.extension_id, allowed_origin, browsers, args.profile_dir, args.install_dir)
            print(f"Installed {HOST_NAME} for {', '.join(browsers)}.")
        else:
            uninstall(args.extension_id, allowed_origin, browsers, args.profile_dir, args.install_dir)
            print(f"Removed {HOST_NAME} registration for {', '.join(browsers)}.")
    except (OSError, RuntimeError, ValueError) as error:
        # This tool never receives a key, and errors contain only install paths
        # or validation text. Host errors never flow through this installer.
        print(f"Motion keychain companion: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
