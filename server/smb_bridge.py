"""Run one authenticated SMB2/3 read using a JSON request on stdin."""
import json
import os
import re
import sys
import uuid
from contextlib import ExitStack

MAX_DIRECTORY_ENTRIES = 20000
MAX_LYRIC_BYTES = 1000000
MAX_COVER_BYTES = 8 * 1024 * 1024
FOLDER_COVER = re.compile(r"cover\.(png|jpe?g)\Z", re.IGNORECASE)
ARTIST_PORTRAIT = re.compile(r".+\.(png|jpe?g)\Z", re.IGNORECASE)
RANGE = re.compile(r"bytes=(\d{0,16})-(\d{0,16})\Z")
out = sys.stdout.buffer
sent = False


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code


def send(data):
    global sent
    out.write(json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n")
    out.flush()
    sent = True


def valid_part(value):
    return (isinstance(value, str) and 0 < len(value) <= 255
            and value not in (".", "..") and value[-1] not in " ."
            and not re.search(r'[\\/:*?"<>|\x00-\x1f\x7f]', value))


def open_item(tree, parts, directory):
    from smbprotocol.open import (
        CreateDisposition, CreateOptions, FileAttributes, FilePipePrinterAccessMask,
        ImpersonationLevel, Open, ShareAccess,
    )

    if len(parts) > 40 or not all(valid_part(part) for part in parts):
        raise BridgeError("invalid")
    if not directory and not parts:
        raise BridgeError("invalid")
    handle = Open(tree, "\\".join(parts))
    options = CreateOptions.FILE_OPEN_REPARSE_POINT | (
        CreateOptions.FILE_DIRECTORY_FILE if directory else CreateOptions.FILE_NON_DIRECTORY_FILE
    )
    handle.create(
        ImpersonationLevel.Impersonation,
        FilePipePrinterAccessMask.GENERIC_READ,
        FileAttributes.FILE_ATTRIBUTE_NORMAL,
        ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE,
        CreateDisposition.FILE_OPEN,
        options,
    )
    if handle.file_attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
        handle.close()
        raise BridgeError("link")
    return handle


def list_entries(handle, portraits):
    from smbprotocol.exceptions import NoMoreFiles, NoSuchFile
    from smbprotocol.file_info import FileInformationClass
    from smbprotocol.open import FileAttributes

    entries = []
    seen = 0
    while True:
        try:
            rows = handle.query_directory("*", FileInformationClass.FILE_DIRECTORY_INFORMATION)
        except (NoMoreFiles, NoSuchFile):
            break
        if not rows:
            break
        for row in rows:
            name = row["file_name"].get_value().decode("utf-16-le", errors="replace")
            attributes = row["file_attributes"].get_value()
            if not valid_part(name) or attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                continue
            seen += 1
            if seen >= MAX_DIRECTORY_ENTRIES:
                raise BridgeError("too_many")
            directory = bool(attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
            if portraits and (directory or not ARTIST_PORTRAIT.fullmatch(name)):
                continue
            entry = {"name": name, "folder": directory, "size": 0 if directory else row["end_of_file"].get_value()}
            if portraits or (not directory and FOLDER_COVER.fullmatch(name)):
                entry["modified"] = row["last_write_time"].get_value().isoformat()
            entries.append(entry)
    send({"entries": entries})


def media_range(size, raw):
    if not raw:
        return 200, 0, size
    parsed = RANGE.fullmatch(raw)
    if not parsed or not size:
        return 416, 0, 0
    first, last = parsed.groups()
    if not first:
        length = int(last or "0")
        return (206, max(0, size - length), size) if length else (416, 0, 0)
    start = int(first)
    stop = min(size, int(last) + 1) if last else size
    return (206, start, stop) if start < stop else (416, 0, 0)


def stream_file(handle, config):
    size = handle.end_of_file
    if config.get("lyrics") and size > MAX_LYRIC_BYTES:
        raise BridgeError("too_large")
    if config.get("cover") and size > MAX_COVER_BYTES:
        raise BridgeError("cover_too_large")
    status, start, stop = media_range(size, config.get("range"))
    send({"status": status, "size": size, "start": start, "stop": stop})
    if config["action"] == "head" or status == 416:
        return
    position = start
    while position < stop:
        data = handle.read(position, min(65536, stop - position))
        if not data:
            raise BridgeError("unavailable")
        out.write(data)
        out.flush()
        position += len(data)


def run(config):
    from smbprotocol.connection import Connection
    from smbprotocol.session import Session
    from smbprotocol.tree import TreeConnect

    host = config["host"]
    share = config["share"]
    if not valid_part(share):
        raise BridgeError("invalid")
    connection = Connection(uuid.uuid4(), host, config["port"], require_signing=True)
    try:
        connection.connect(timeout=7)
        session = Session(connection, config["username"], config["password"], require_encryption=config["encrypt"])
        session.connect()
        tree = TreeConnect(session, f"\\\\{host}\\{share}")
        tree.connect()
        if tree.is_dfs_share:
            raise BridgeError("link")
        parts = config["parts"]
        portraits = config["action"] == "artist_portraits"
        directory = portraits or config["action"] == "list"
        with ExitStack() as stack:
            for depth in range(1, len(parts)):
                ancestor = open_item(tree, parts[:depth], True)
                stack.callback(ancestor.close)
            handle = open_item(tree, parts, directory)
            stack.callback(handle.close)
            if directory:
                list_entries(handle, portraits)
            else:
                stream_file(handle, config)
    finally:
        connection.disconnect(True)


def report_failure(error):
    from smbprotocol.exceptions import SMBAuthenticationError, SMBResponseException
    from smbprotocol.header import NtStatus

    if isinstance(error, BridgeError):
        return error.code
    if isinstance(error, SMBAuthenticationError):
        return "denied"
    if isinstance(error, SMBResponseException):
        if error.status in (
            NtStatus.STATUS_LOGON_FAILURE, NtStatus.STATUS_ACCESS_DENIED, NtStatus.STATUS_WRONG_PASSWORD,
        ):
            return "denied"
        if error.status in (
            NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND,
            NtStatus.STATUS_NO_SUCH_FILE, NtStatus.STATUS_BAD_NETWORK_NAME,
        ):
            return "not_found"
    return "unavailable"


if __name__ == "__main__":
    os.environ.setdefault("SMB_EXPERIMENTAL_TRANSPORT_RECEIVE_TIMEOUT", "20")
    try:
        cfg = json.loads(sys.stdin.buffer.readline(32000))
        run(cfg)
    except ModuleNotFoundError:
        if not sent:
            send({"error": "missing"})
        sys.exit(1)
    except Exception as exc:
        if not sent:
            send({"error": report_failure(exc)})
        sys.exit(1)
