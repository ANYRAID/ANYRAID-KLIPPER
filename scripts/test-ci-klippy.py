#!/usr/bin/env python3
"""Check regression file isolation and CI failure propagation."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'test_klippy', Path(__file__).with_name('test_klippy.py'))
klippy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(klippy)


class IsolationTests(unittest.TestCase):
    def test_output_cleanup_and_failure_log_are_isolated(self):
        with tempfile.TemporaryDirectory() as root:
            left, right = Path(root) / 'py3', Path(root) / 'py2'
            left.mkdir()
            right.mkdir()
            sentinel = right / '_test_output-other'
            sentinel.write_text('other interpreter')
            case = klippy.TestCase('unused', '.', str(left), False, False)

            def fake_process(args):
                output = Path(args[args.index('-o') + 1])
                log = Path(args[args.index('-l') + 1])
                gcode = Path(args[args.index('-i') + 1])
                self.assertEqual(output.parent, left)
                self.assertEqual(log.parent, left)
                self.assertEqual(gcode.parent, left)
                output.write_text('output')
                Path(str(output) + '-mcu').write_text('second MCU')
                log.write_text('failure from this interpreter')
                return 1 if self.fail_process else 0

            with patch.object(klippy.subprocess, 'call', fake_process):
                self.fail_process = False
                case.launch_test('config', ['dict'], None, ['G28'], False)
                self.assertEqual(list(left.iterdir()), [])
                self.assertTrue(sentinel.exists())
                self.fail_process = True
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    with self.assertRaises(klippy.error):
                        case.launch_test('config', ['dict'], None, [], False)
                self.assertIn('failure from this interpreter',
                              output.getvalue())
                self.assertTrue(sentinel.exists())
                # An expected failure remains a passing test and is cleaned up.
                case.launch_test('config', ['dict'], None, [], True)
                self.assertEqual(list(left.iterdir()), [])

    @unittest.skipUnless(os.name == 'posix', 'CI shell runs on Linux')
    def test_both_suites_finish_and_either_failure_fails_ci(self):
        script = Path(__file__).with_name('ci-build.sh').read_text()
        block = script[script.index('TESTS=(test/klippy/*.test)'):]
        prelude = '''set -eu
unset GITHUB_STEP_SUMMARY
BUILD_DIR=$PWD
DICTDIR=$PWD
PYTHON=$PWD/py3
PYTHON2=$PWD/py2
TOTAL_START=$SECONDS
MCU_SECONDS=0
BUILD_JOBS=1
CONFIGS=(fixture)
finish_test() { :; }
'''
        for parallel in (0, 1):
            for code3, code2 in ((0, 0), (1, 0), (0, 1)):
                with self.subTest(parallel=parallel, codes=(code3, code2)):
                    with tempfile.TemporaryDirectory() as root:
                        for name, code in (('py3', code3), ('py2', code2)):
                            path = Path(root) / name
                            path.write_text('#!/bin/sh\nexit %d\n' % code)
                            path.chmod(0o755)
                        result = subprocess.run(
                            ['bash'], input=prelude +
                            'PARALLEL_TESTS=%d\n' % parallel + block,
                            cwd=root, text=True, capture_output=True,
                            timeout=10)
                        self.assertEqual(result.returncode == 0,
                                         code3 == 0 and code2 == 0,
                                         result.stderr)
                        self.assertEqual(result.stdout.count(
                            'Suite finished:'), 2, result.stdout)


if __name__ == '__main__':
    unittest.main()
