#!/usr/bin/env python3
"""Cache and download the exact archives selected by APT for CI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from urllib.parse import urlsplit, urlunsplit

PACKAGES = (
    'virtualenv python2-dev libffi-dev build-essential gcc-avr avr-libc '
    'libnewlib-arm-none-eabi gcc-arm-none-eabi binutils-arm-none-eabi'
).split()


def parse_plan(output):
    packages = []
    for line in output.splitlines():
        if not line.startswith("'"):
            continue
        url, name, size, digest = shlex.split(line)
        if (Path(name).name != name or not name.endswith('.deb')
                or not digest.startswith('SHA256:')
                or len(digest.split(':')[1]) != 64):
            raise ValueError('Unexpected APT archive metadata: ' + line)
        packages.append(dict(url=url, name=name, size=int(size), digest=digest))
    return packages


def valid_archive(path, package):
    if not path.is_file() or path.stat().st_size != package['size']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return 'SHA256:' + digest.hexdigest() == package['digest']


def fallback_url(url):
    parts = urlsplit(url)
    if parts.hostname == 'azure.archive.ubuntu.com':
        return urlunsplit(('https', 'archive.ubuntu.com', parts.path,
                           parts.query, parts.fragment))
    return url


def download(packages, cache, budget=300):
    cache.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    for fallback in (False, True):
        deadline = time.monotonic() + budget
        try:
            for package in packages:
                target = cache / package['name']
                if valid_archive(target, package):
                    print('APT cache verified: ' + package['name'], flush=True)
                    continue
                target.unlink(missing_ok=True)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('APT archive download budget exhausted')
                url = package['url']
                if fallback:
                    url = fallback_url(url)
                print('APT download: ' + url, flush=True)
                subprocess.run([
                    'timeout', '--kill-after=5s', str(remaining) + 's',
                    '/usr/lib/apt/apt-helper',
                    '-o', 'Acquire::Retries=1',
                    '-o', 'Acquire::http::Timeout=30',
                    '-o', 'Acquire::https::Timeout=30',
                    'download-file', url, str(target), package['digest'],
                ], check=True)
                if not valid_archive(target, package):
                    raise ValueError('APT archive checksum mismatch: '
                                     + package['name'])
            print('APT archives ready in %.1fs' % (
                time.monotonic() - started), flush=True)
            return
        except (subprocess.SubprocessError, TimeoutError, ValueError) as error:
            if fallback:
                raise
            print('::warning::APT primary download failed; retrying missing '
                  'archives via Ubuntu official fallback: ' + str(error),
                  flush=True)
    raise RuntimeError('APT download did not finish')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'install'])
    args = parser.parse_args()
    root = Path(os.environ.get('RUNNER_TEMP', 'ci_build')).resolve()
    root.mkdir(parents=True, exist_ok=True)
    plan_path = root / 'apt-plan.json'
    cache = root / 'apt-archives'
    if args.action == 'plan':
        subprocess.run([
            'sudo', 'apt-get', '-o', 'Acquire::Retries=2',
            '-o', 'Acquire::http::Timeout=30',
            '-o', 'Acquire::https::Timeout=30',
            '-o', 'APT::Update::Error-Mode=any', 'update',
        ], check=True, timeout=300)
        # Use a separate, empty archive path so the plan is cache-independent.
        empty = root / 'apt-plan-archives'
        empty.mkdir(exist_ok=True)
        result = subprocess.run([
            'sudo', 'apt-get', '-o', 'Acquire::ForceHash=SHA256',
            '-o', 'Dir::Cache::archives=' + str(empty),
            '--print-uris', '--download-only', '--yes', 'install', *PACKAGES,
        ], check=True, text=True, stdout=subprocess.PIPE)
        print(result.stdout)
        packages = parse_plan(result.stdout)
        plan_path.write_text(json.dumps(packages), encoding='utf-8')
        # Include exact filenames/versions and hashes, but not mirror URLs.
        identity = [(p['name'], p['size'], p['digest']) for p in packages]
        key = hashlib.sha256(json.dumps(sorted(identity)).encode()).hexdigest()
        if 'GITHUB_OUTPUT' in os.environ:
            with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
                stream.write('digest=' + key + '\n')
        print('APT plan: %d archives, %d bytes' % (
            len(packages), sum(p['size'] for p in packages)))
    else:
        packages = json.loads(plan_path.read_text(encoding='utf-8'))
        download(packages, cache)
        # Install normally, but never silently start another network download.
        started = time.monotonic()
        subprocess.run([
            'sudo', 'apt-get', '-o', 'Dir::Cache::archives=' + str(cache),
            '--no-download', '--yes', 'install', *PACKAGES,
        ], check=True)
        print('APT install completed in %.1fs' % (
            time.monotonic() - started), flush=True)


if __name__ == '__main__':
    main()
