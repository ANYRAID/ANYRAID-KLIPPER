# Verified virtual SD starts and signed history receipts.
#
# This file may be distributed under the terms of the GNU GPLv3 license.
import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
import tempfile
import time
from contextlib import closing
from pathlib import Path

RECEIPT_FIELDS = (
    'origin', 'databaseGeneration', 'backendEpoch', 'taskId', 'startId',
    'authorityKeyId', 'filename', 'fileSha256')
INTENT_FIELDS = RECEIPT_FIELDS + ('expiresAt',)
INTENT_DOMAIN = b'screen-history-start-intent-v1\0'
RECEIPT_DOMAIN = b'screen-history-start-receipt-v1\0'
ORIGIN = re.compile(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})')
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,128}')
UUID4 = re.compile(
    r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
HEX32 = re.compile(r'[0-9a-f]{64}')
SIGNATURE = re.compile(r'[A-Za-z0-9_-]{86}')
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
MAX_LIFETIME = 300


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _message(domain, fields, data):
    values = [data[field] for field in fields]
    return domain + json.dumps(
        values, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def _base64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _read_seed(path):
    fd = os.open(path, FILE_FLAGS)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError('Expected a private key file')
        value = stream.read(67).decode('ascii')
    if value.endswith('\n'):
        value = value[:-1]
    if not _matches(HEX32, value):
        raise ValueError('Expected a 32-byte seed')
    return bytes.fromhex(value)


def _open_source(root, filename):
    parts = filename.split('/')
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(root, dir_flags)
    try:
        for part in parts[:-1]:
            child = os.open(part, dir_flags, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], FILE_FLAGS, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError('Expected a regular file')
        return os.fdopen(fd, 'rb')
    finally:
        os.close(directory)


class ScreenStartReceipt:
    def __init__(self, config, gcode_dir):
        self.origin = config.get('screen_start_origin')
        self.authority = config.get('screen_start_authority_key_id')
        dispatch_key = config.get('screen_start_dispatch_public_key')
        seed_path = os.path.expanduser(config.get('screen_start_signing_key'))
        self.state_dir = os.path.expanduser(
            config.get('screen_start_state_dir'))
        self.source_root = os.path.realpath(gcode_dir)
        self.database = Path(self.state_dir) / 'consumed-starts.sqlite3'
        match = ORIGIN.fullmatch(self.origin)
        if (not match or not 1 <= int(match[1]) <= 65535 or int(match[1]) == 80
                or not _matches(HEX32, self.authority)
                or not _matches(HEX32, dispatch_key)
                or not os.path.isabs(seed_path)
                or not os.path.isabs(self.state_dir)
                or any(os.path.commonpath(
                    (self.source_root, os.path.realpath(path)))
                    == self.source_root
                    for path in (seed_path, self.state_dir))):
            raise config.error('Invalid screen start receipt configuration')
        try:
            from libnacl.sign import Signer, Verifier
            self.signer = Signer(_read_seed(seed_path))
            self.verifier = Verifier(dispatch_key.encode('ascii'))
            if self.signer.vk.hex() == dispatch_key:
                raise ValueError('Receipt and intent keys must differ')
            info = os.stat(self.state_dir, follow_symlinks=False)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_mode & 0o077):
                raise ValueError('Expected a private state directory')
            if os.path.lexists(self.database):
                self._database_identity()
            with closing(sqlite3.connect(str(self.database))) as db, db:
                db.execute(
                    'CREATE TABLE IF NOT EXISTS consumed ('
                    'start_id TEXT PRIMARY KEY NOT NULL, '
                    'backend_epoch TEXT NOT NULL, task_id TEXT NOT NULL, '
                    'UNIQUE (backend_epoch, task_id))')
            self.database_uri = self.database.as_uri() + '?mode=rw'
            self.database_identity = self._database_identity()
            self.database_fd = os.open(self.database, FILE_FLAGS)
            try:
                info = os.fstat(self.database_fd)
                if (info.st_dev, info.st_ino) != self.database_identity:
                    raise ValueError('Screen start ledger changed')
            except Exception:
                self.close()
                raise
        except (ImportError, OSError, ValueError, sqlite3.Error):
            raise config.error('Unable to initialize screen start receipt keys '
                               'or state') from None

    def close(self):
        if self.database_fd is not None:
            os.close(self.database_fd)
            self.database_fd = None

    def _database_identity(self):
        info = os.stat(self.database, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1):
            raise ValueError('Expected a private start ledger')
        return info.st_dev, info.st_ino

    def _check_database(self):
        if self._database_identity() != self.database_identity:
            raise ValueError('Screen start ledger changed')

    def validate(self, intent):
        if intent.keys() != set(INTENT_FIELDS) | {'signature'}:
            raise ValueError('Invalid screen start intent')
        filename = intent['filename']
        if (intent['origin'] != self.origin
                or intent['authorityKeyId'] != self.authority
                or not _matches(UUID4, intent['databaseGeneration'])
                or not _matches(UUID4, intent['startId'])
                or not _matches(IDENTIFIER, intent['backendEpoch'])
                or not _matches(IDENTIFIER, intent['taskId'])
                or not _matches(HEX32, intent['fileSha256'])
                or not _matches(SIGNATURE, intent['signature'])
                or not isinstance(filename, str)
                or not 1 <= len(filename) <= 4096
                or any(part in ('', '.', '..') for part in filename.split('/'))
                or '\\' in filename
                or any(ord(char) < 32 or ord(char) == 127
                       for char in filename)):
            raise ValueError('Invalid screen start intent')
        self.check_expiry(intent)
        signature = base64.urlsafe_b64decode(intent['signature'] + '==')
        if _base64url(signature) != intent['signature']:
            raise ValueError('Invalid screen start signature')
        self.verifier.verify(
            signature + _message(INTENT_DOMAIN, INTENT_FIELDS, intent))

    def check_expiry(self, intent):
        now = int(time.time())
        expiry = intent['expiresAt']
        if type(expiry) is not int or not now < expiry <= now + MAX_LIFETIME:
            raise ValueError('Expired or invalid screen start intent')

    def prepare(self, intent, allowed_extensions):
        self.validate(intent)
        filename = intent['filename']
        if filename.rpartition('.')[2] not in allowed_extensions:
            raise ValueError('Unsupported print file type')
        snapshot = tempfile.TemporaryFile(dir=self.state_dir, buffering=0)
        try:
            digest = hashlib.sha256()
            size = 0
            with _open_source(self.source_root, filename) as source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    self.check_expiry(intent)
                    digest.update(chunk)
                    if snapshot.write(chunk) != len(chunk):
                        raise OSError('Incomplete screen start snapshot')
                    size += len(chunk)
            snapshot.seek(0)
            if digest.hexdigest() != intent['fileSha256']:
                raise ValueError('Screen start file digest mismatch')
            self.check_expiry(intent)
            self._check_database()
            connection = sqlite3.connect(self.database_uri, uri=True)
            with closing(connection) as db, db:
                db.execute('PRAGMA synchronous = FULL')
                db.execute('INSERT INTO consumed VALUES (?, ?, ?)',
                           (intent['startId'], intent['backendEpoch'],
                            intent['taskId']))
                self._check_database()
            self._check_database()
            return snapshot, size
        except Exception:
            snapshot.close()
            raise

    def issue(self, intent):
        receipt = {field: intent[field] for field in RECEIPT_FIELDS}
        message = _message(RECEIPT_DOMAIN, RECEIPT_FIELDS, receipt)
        receipt['signature'] = _base64url(self.signer.signature(message))
        return receipt
