# Packaging Klipper

Klipper is somewhat of a packaging anomaly among python programs, as it doesn't
use setuptools to build and install. Some notes regarding how best to package it
are as follows:

## C modules

Klipper uses a C module to handle some kinematics calculations more quickly.
This module needs to be compiled at packaging time to avoid introducing a
runtime dependency on a compiler. To compile the C module, run `python2
klippy/chelper/__init__.py`.

## Compiling python code

Many distributions have a policy of compiling all python code before packaging
to improve startup time. You can do this by running `python2 -m compileall
klippy`.

## Versioning

If you are building a package of Klipper from git, it is usual practice not to
ship a .git directory, so the versioning must be handled without git.  To do
this, use Node.js 26 to run the dependency-free TypeScript tool:
`node scripts/make_version.mts YOURDISTRONAME > klippy/.version`.
It reads the repository containing the script, regardless of the working
directory, and preserves the Git tag/commit/dirty suffix and distribution naming
format of the former Python tool. Source archives without Git metadata produce
`?-YOURDISTRONAME`; generate `.version` before removing `.git` to retain the
actual revision. Control characters in distribution names are rejected.

This versioning tool no longer requires Python. The C-helper compilation and
Python bytecode steps above still describe the legacy host; the complete host
migration and remaining gates are tracked in [Node_Host_Migration.md](Node_Host_Migration.md).

## Sample packaging script

klipper-git is packaged for Arch Linux, and has a PKGBUILD (package build
script) available at [Arch User Repository](https://aur.archlinux.org/cgit/aur.git/tree/PKGBUILD?h=klipper-git).
