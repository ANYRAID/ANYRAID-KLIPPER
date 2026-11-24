# Offline tests of the authenticated virtual SD start boundary.
#
# This file may be distributed under the terms of the GNU GPLv3 license.
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'klippy'))

from gcode import CommandError, GCodeDispatch
from extras import pause_resume, print_stats, screen_start_receipt
from extras import virtual_sdcard
from webhooks import GCodeHelper, QueryStatusHelper, WebRequest, WebRequestError


class OfflineReactor:
    NOW = 0.
    NEVER = float('inf')

    def __init__(self):
        self.paused = lambda: None
        self.timers = []

    def monotonic(self):
        return time.monotonic()

    def register_timer(self, callback, when):
        self.timers.append(callback)
        return callback

    def unregister_timer(self, timer):
        self.timers.remove(timer)

    def pause(self, when):
        self.paused()

    def mutex(self):
        return OfflineMutex()

    def assert_no_pause(self):
        return nullcontext()

    def completion(self):
        return OfflineCompletion(self)


class OfflineCompletion:
    def __init__(self, reactor):
        self.reactor = reactor

    def complete(self, value):
        self.value = value

    def wait(self):
        self.reactor.timers[0](self.reactor.monotonic())
        return self.value


class OfflineMutex:
    def __enter__(self):
        pass

    def __exit__(self, *exc):
        pass

    def test(self):
        return False


class OfflineExecutor:
    def submit(self, callback, *args):
        return callback(*args)

    def wrap_obj(self, obj):
        return obj


class OfflinePrinter:
    command_error = CommandError
    config_error = ValueError

    def __init__(self):
        self.reactor = OfflineReactor()
        self.events = {}
        self.objects = {
            'gcode': GCodeDispatch(self),
            'webhooks': SimpleNamespace(register_endpoint=lambda *args: None),
            'gcode_move': SimpleNamespace(get_status=lambda _: {
                'position': SimpleNamespace(e=0.), 'extrude_factor': 1.}),
            'aio_executor': SimpleNamespace(
                allocate_executor=lambda _: OfflineExecutor()),
            'gcode_macro': SimpleNamespace(load_template=lambda *args: None)
        }

    def get_start_args(self):
        return {}

    def get_reactor(self):
        return self.reactor

    def lookup_object(self, name, default=None):
        return self.objects.get(name, default)

    def load_object(self, config, name):
        if name == 'print_stats':
            self.objects[name] = print_stats.PrintStats(config)
        return self.objects[name]

    def register_event_handler(self, name, callback):
        self.events.setdefault(name, []).append(callback)

    def send_event(self, name):
        for callback in self.events.get(name, ()):
            callback()


class OfflineSubscriber:
    def __init__(self):
        self.notifications = []

    def is_closed(self):
        return False

    def send(self, message):
        self.notifications.append(message['params']['status'])


class OfflineConfig:
    error = ValueError

    def __init__(self, printer, values):
        self.printer = printer
        self.values = values

    def get_printer(self):
        return self.printer

    def get(self, name):
        return self.values[name]

    def getboolean(self, name, default):
        return self.values.get(name, default)


class OfflineKlippy:
    def __init__(self, gcode_dir, state_dir, seed_path, origin,
                 authority_key_id, dispatch_public_key, enabled=True):
        self.printer = OfflinePrinter()
        self.gcode = self.printer.objects['gcode']
        self.dispatched = []
        self.gcode.run_script = self.dispatched.append
        self.reactor = self.printer.reactor
        self.sd = virtual_sdcard.VirtualSD(OfflineConfig(self.printer, {
            'path': str(gcode_dir), 'screen_start_receipts': enabled,
            'screen_start_origin': origin,
            'screen_start_authority_key_id': authority_key_id,
            'screen_start_dispatch_public_key': dispatch_public_key,
            'screen_start_signing_key': str(seed_path),
            'screen_start_state_dir': str(state_dir)
        }))
        self.printer.objects['virtual_sdcard'] = self.sd
        self.gcode._handle_ready()
        self.webhook = GCodeHelper(self.printer)
        self.query = QueryStatusHelper(self.printer)
        self.subscriber = OfflineSubscriber()
        request = WebRequest(self.subscriber, json.dumps({
            'method': 'objects/subscribe', 'params': {
                'objects': {'print_stats': None}}}).encode())
        self.query._handle_subscribe(request)
        self.print_updates = self.subscriber.notifications

    def request_script(self, **params):
        request = WebRequest(None, json.dumps({
            'method': 'gcode/script', 'params': params}).encode())
        self.webhook._handle_script(request)

    def submit(self, intent):
        self.request_script(anyraid_start_intent=intent)

    def status(self):
        return self.sd.print_stats.get_status(self.reactor.monotonic())

    def close(self):
        self.printer.send_event('klippy:disconnect')

    def run_start(self):
        observed = []
        self.reactor.paused = lambda: observed.append(self.status())
        self.sd.work_timer(self.reactor.monotonic())
        return next((status for status in observed
                     if status['state'] == 'printing'), None)


def make_klippy(gcode_dir, state_dir, seed_path, origin, authority_key_id,
                dispatch_public_key, enabled=True):
    return OfflineKlippy(gcode_dir, state_dir, seed_path, origin,
                         authority_key_id, dispatch_public_key, enabled)


class ScreenStartReceiptTest(unittest.TestCase):
    def setUp(self):
        from libnacl.sign import Signer

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.gcode_dir = root / 'gcodes'
        self.gcode_dir.mkdir()
        self.state_dir = root / 'private'
        self.state_dir.mkdir(mode=0o700)
        self.filename = '子目录/sample.gcode'
        self.path = self.gcode_dir / self.filename
        self.path.parent.mkdir()
        self.contents = b'; original file\n'
        self.path.write_bytes(self.contents)
        self.seed_path = self.state_dir / 'issuer'
        self.seed_path.write_text('6b' * 32 + '\n')
        self.seed_path.chmod(0o600)
        self.issuer = Signer(bytes.fromhex('6b' * 32))
        self.dispatch = Signer(bytes.fromhex('44' * 32))
        self.origin = 'http://127.0.0.1:7125'
        self.authority_key_id = '3d' * 32
        self.klippy = self.new_klippy()

    def new_klippy(self, enabled=True):
        result = make_klippy(
            self.gcode_dir, self.state_dir, self.seed_path, self.origin,
            self.authority_key_id, self.dispatch.vk.hex(), enabled)
        self.addCleanup(result.close)
        return result

    def intent(self, **kwargs):
        values = {
            'origin': self.origin, 'databaseGeneration': str(uuid.uuid4()),
            'backendEpoch': 'epoch-1', 'taskId': 'task-1',
            'startId': str(uuid.uuid4()),
            'authorityKeyId': self.authority_key_id, 'filename': self.filename,
            'fileSha256': hashlib.sha256(self.contents).hexdigest(),
            'expiresAt': int(time.time()) + 30, **kwargs
        }
        msg = screen_start_receipt._message(
            screen_start_receipt.INTENT_DOMAIN,
            screen_start_receipt.INTENT_FIELDS, values)
        values['signature'] = screen_start_receipt._base64url(
            self.dispatch.signature(msg))
        return values

    def test_receipt_binds_executed_snapshot_and_ordinary_start_clears_it(self):
        import base64
        from libnacl.sign import Verifier

        intent = self.intent()
        self.klippy.submit(intent)
        self.assertIsNone(self.klippy.status()['anyraid_start_receipt'])
        self.assertEqual(self.klippy.sd.file_path(), str(self.path))
        self.path.write_bytes(b'; replacement at same path\n')
        status = self.klippy.run_start()
        receipt = status['anyraid_start_receipt']
        signature = base64.urlsafe_b64decode(receipt['signature'] + '==')
        fields = screen_start_receipt.RECEIPT_FIELDS
        self.assertEqual(set(receipt), set(fields) | {'signature'})
        self.assertEqual([receipt[key] for key in fields],
                         [intent[key] for key in fields])
        expected = b'screen-history-start-receipt-v1\0' + json.dumps(
            [intent[key] for key in fields], ensure_ascii=False,
            separators=(',', ':')).encode()
        self.assertEqual(Verifier(self.issuer.hex_vk()).verify(
            signature + expected), expected)
        updates = [update['print_stats']
                   for update in self.klippy.print_updates]
        printing = [update for update in updates
                    if update.get('state') == 'printing']
        self.assertEqual(len(printing), 1)
        self.assertEqual(printing[0]['anyraid_start_receipt'], receipt)
        self.assertEqual(self.klippy.dispatched, ['; original file'])
        gcmd = SimpleNamespace(get=lambda _: self.filename,
                               respond_raw=lambda _: None)
        self.klippy.sd.cmd_SDCARD_PRINT_FILE(gcmd)
        self.assertIsNone(self.klippy.run_start()['anyraid_start_receipt'])
        self.assertEqual(self.klippy.dispatched[-1],
                         '; replacement at same path')

    def test_replay_rejected_across_instances_for_both_unique_keys(self):
        intent = self.intent()
        self.klippy.submit(intent)
        self.klippy.run_start()
        self.klippy.close()
        restarted = self.new_klippy()
        for replay in (intent,
                       self.intent(startId=intent['startId'], taskId='task-2'),
                       self.intent()):
            with self.assertRaises(CommandError):
                restarted.submit(replay)
            self.assertIsNone(restarted.sd.work_timer)

    def test_invalid_intents_cannot_select_a_file(self):
        tampered = self.intent()
        tampered['taskId'] = 'changed'
        link = self.gcode_dir / 'external'
        link.symlink_to(self.state_dir, target_is_directory=True)
        file_link = self.gcode_dir / 'symlink.gcode'
        file_link.symlink_to(self.path)
        fifo = self.gcode_dir / 'fifo.gcode'
        os.mkfifo(fifo)
        for intent in (tampered, self.intent(filename='../sample.gcode'),
                       self.intent(filename='external/sample.gcode'),
                       self.intent(filename='symlink.gcode'),
                       self.intent(filename='fifo.gcode'),
                       self.intent(fileSha256='00' * 32),
                       self.intent(expiresAt=int(time.time()) - 1)):
            with self.assertRaises(CommandError):
                self.klippy.submit(intent)
            self.assertIsNone(self.klippy.sd.current_file)
            self.assertIsNone(self.klippy.sd.work_timer)

    def test_disabled_replaced_busy_and_unready_paths(self):
        with self.assertRaises(CommandError):
            self.new_klippy(enabled=False).submit(self.intent())
        with self.assertRaises(WebRequestError):
            self.klippy.request_script(
                script='ignore', anyraid_start_intent=self.intent())
        self.klippy.request_script(script='standard script')
        self.assertEqual(self.klippy.dispatched, ['standard script'])
        handler = self.klippy.gcode.register_command('SDCARD_PRINT_FILE', None)
        self.klippy.gcode.register_command('SDCARD_PRINT_FILE', lambda _: None)
        with self.assertRaises(CommandError):
            self.klippy.submit(self.intent())
        self.klippy.gcode.gcode_handlers['SDCARD_PRINT_FILE'] = \
            handler
        self.klippy.sd.work_timer = object()
        with self.assertRaises(CommandError):
            self.klippy.submit(self.intent())
        self.klippy.sd.work_timer = None
        self.klippy.gcode._handle_shutdown()
        with self.assertRaises(CommandError):
            self.klippy.submit(self.intent())

    def test_expired_and_aborted_before_first_read_emit_no_receipt(self):
        intent = self.intent()
        self.klippy.submit(intent)
        with patch.object(screen_start_receipt.time, 'time',
                          return_value=intent['expiresAt']):
            self.assertIsNone(self.klippy.run_start())
        self.klippy.submit(self.intent(taskId='task-2'))
        self.klippy.sd.must_pause_work = True
        self.assertIsNone(self.klippy.run_start())
        self.assertIsNone(self.klippy.status()['anyraid_start_receipt'])
        self.assertIsNone(self.klippy.sd.current_file)
        self.assertEqual(self.klippy.dispatched, [])

    def test_cancel_during_prepare_prevents_later_start(self):
        pause = object.__new__(pause_resume.PauseResume)
        pause.v_sd = self.klippy.sd
        pause.sd_paused = False
        prepare = self.klippy.sd.screen_start_receipt.prepare

        def prepare_then_cancel(*args):
            prepared = prepare(*args)
            pause.cmd_CANCEL_PRINT(SimpleNamespace(respond_info=lambda _: None))
            return prepared

        with patch.object(self.klippy.sd.screen_start_receipt, 'prepare',
                          prepare_then_cancel):
            with self.assertRaises(CommandError):
                self.klippy.submit(self.intent())
        self.assertIsNone(self.klippy.sd.work_timer)
        self.assertIsNone(self.klippy.sd.current_file)

    def test_missing_or_replaced_ledger_fails_closed_during_process(self):
        database = self.klippy.sd.screen_start_receipt.database
        saved = database.with_suffix('.saved')
        database.rename(saved)
        with self.assertRaises(CommandError):
            self.klippy.submit(self.intent())
        database.write_bytes(saved.read_bytes())
        with self.assertRaises(CommandError):
            self.klippy.submit(self.intent())
        self.assertIsNone(self.klippy.sd.work_timer)


if __name__ == '__main__':
    unittest.main()
