#!/usr/bin/env python3
"""A scratch place for the mutation checks to work in.

A mutation check breaks the code it is checking on purpose and puts it back
afterwards. Doing that in the working tree costs more than it looks:

* an interrupted run leaves a broken file behind, and the next person to
  read that file reads a mutation and believes it is the product;
* a run that overlaps somebody else's change takes that change with it,
  because the file is written back from a copy taken before the other work.

Both have happened in this project. A test failed because of a mutation
left in the tree, and a whole afternoon of work on the panel was lost
because a gate wrote a file it had read before the work started.

So the check takes the blame out of the tree. It copies the project into a
scratch directory, breaks the code there, and throws the copy away when it
is done. The working tree is only ever read.

The copy is cheap: the heavy parts (git history, installed packages) are
left out, and the packages are linked rather than copied.
"""

import atexit
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

# The project this file lives in. This is the only place the real tree is
# read from.
REAL_ROOT = Path(__file__).resolve().parent.parent

# What the copy leaves out. The git history is far bigger than the code and
# no check reads it. The installed packages are linked back in, because the
# tests need them and copying them would be slow.
EXCLUDED = (
    ".git",
    "node_modules",
    "server/node_modules",
    "__pycache__",
    ".venv",
    "dist",
)

# The packages the tests ask for by name.
LINKED_PACKAGES = ("node_modules", "server/node_modules")


def _copy_project(source, target):
    """Copies the project, minus the parts no check reads."""
    rsync = shutil.which("rsync")
    if rsync:
        command = [rsync, "-a"]
        for name in EXCLUDED:
            command.append(f"--exclude={name}/")
        command.append(f"{source}/")
        command.append(f"{target}/")
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            raise SystemExit(
                f"could not copy the project for the check:\n{result.stderr}"
            )
        return

    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns(*EXCLUDED),
        dirs_exist_ok=True,
    )


def _link_packages(source, target):
    """Links the installed packages back in, so the tests find them."""
    for name in LINKED_PACKAGES:
        installed = source / name
        if not installed.exists():
            continue
        link = target / name
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.exists() or link.is_symlink():
            continue
        link.symlink_to(installed)


def _remove(path):
    shutil.rmtree(path, ignore_errors=True)


def workspace():
    """Copies the project somewhere safe and works there from now on.

    Returns the copy's path. The copy is thrown away when the process ends,
    so nothing is left behind and the working tree is never written to.
    """
    scratch = Path(tempfile.mkdtemp(prefix="ytd-mutation-"))
    atexit.register(_remove, scratch)

    work = scratch / "project"
    work.mkdir()
    _copy_project(REAL_ROOT, work)
    _link_packages(REAL_ROOT, work)

    # The checks run commands with the copy as their working directory, and
    # so do the tests those commands run. Anything that writes a relative
    # path writes into the copy.
    os.chdir(work)
    return work
