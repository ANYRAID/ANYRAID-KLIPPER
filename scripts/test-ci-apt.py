#!/usr/bin/env python3
"""Regression tests for CI archive reuse and bounded mirror fallback."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'ci_apt', Path(__file__).with_name('ci-apt.py'))
apt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apt)
DATA = b'verified package data'
PACKAGE = dict(url='http://azure.archive.ubuntu.com/ubuntu/pool/test.deb',
               name='test_1_amd64.deb', size=len(DATA),
               digest='SHA256:' + hashlib.sha256(DATA).hexdigest())


class AptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name)

    def fetch(self, command, **kwargs):
        self.assertGreater(float(command[2][:-1]), 0)
        self.assertLessEqual(float(command[2][:-1]), 300)
        Path(command[-2]).write_bytes(DATA)

    def test_plan_and_checksum_required(self):
        line = "'%s' %s %s %s" % tuple(PACKAGE.values())
        self.assertEqual(apt.parse_plan('APT output\n' + line), [PACKAGE])
        with self.assertRaises(ValueError):
            apt.parse_plan(line.replace('SHA256:', 'MD5Sum:'))

    def test_warm_cache_does_not_download(self):
        (self.cache / PACKAGE['name']).write_bytes(DATA)
        with patch.object(apt.subprocess, 'run') as run:
            apt.download([PACKAGE], self.cache)
        run.assert_not_called()

    def test_cold_and_corrupted_cache(self):
        for data in (None, b'corrupt'):
            if data is not None:
                (self.cache / PACKAGE['name']).write_bytes(data)
            with patch.object(apt.subprocess, 'run',
                              side_effect=self.fetch) as run:
                apt.download([PACKAGE], self.cache)
            self.assertEqual(run.call_count, 1)
            self.assertTrue(apt.valid_archive(
                self.cache / PACKAGE['name'], PACKAGE))

    def test_timeout_and_failure_use_exact_fallback(self):
        for error in (subprocess.TimeoutExpired('apt-helper', 300),
                      subprocess.CalledProcessError(100, 'apt-helper')):
            (self.cache / PACKAGE['name']).unlink(missing_ok=True)
            calls = []

            def fetch(command, **kwargs):
                calls.append(command)
                if len(calls) == 1:
                    raise error
                self.fetch(command, **kwargs)

            with patch.object(apt.subprocess, 'run', side_effect=fetch):
                apt.download([PACKAGE], self.cache)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1][-3],
                             'https://archive.ubuntu.com/ubuntu/pool/test.deb')
            self.assertEqual(calls[1][-1], PACKAGE['digest'])

    def test_second_failure_is_fatal(self):
        with patch.object(apt.subprocess, 'run', side_effect=
                          subprocess.CalledProcessError(100, 'apt-helper')):
            with self.assertRaises(subprocess.CalledProcessError):
                apt.download([PACKAGE], self.cache)

    def test_checksum_failure_is_fatal(self):
        def corrupt(command, **kwargs):
            Path(command[-2]).write_bytes(b'bad')
        with patch.object(apt.subprocess, 'run', side_effect=corrupt):
            with self.assertRaises(ValueError):
                apt.download([PACKAGE], self.cache)

    def test_other_hosts_are_not_rewritten(self):
        url = 'https://security.ubuntu.com/ubuntu/pool/test.deb'
        self.assertEqual(apt.fallback_url(url), url)

    def test_budget_is_shared_across_packages(self):
        second = dict(PACKAGE, name='second_1_amd64.deb')
        with patch.object(apt.time, 'monotonic',
                          side_effect=[0, 0, 10, 100, 110]), \
                patch.object(apt.subprocess, 'run',
                             side_effect=self.fetch) as run:
            apt.download([PACKAGE, second], self.cache)
        self.assertEqual([float(c.args[0][2][:-1]) for c in run.call_args_list],
                         [290, 200])


if __name__ == '__main__':
    unittest.main()
