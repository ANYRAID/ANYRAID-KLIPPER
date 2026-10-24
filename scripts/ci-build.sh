#!/bin/bash
# Test script for continuous integration.

# Stop script early on any error; check variables
set -eu

# Paths to tools installed by ci-install.sh
MAIN_DIR=${PWD}
BUILD_DIR=${PWD}/ci_build
export PATH=${BUILD_DIR}/pru-elf/bin:${PATH}
export PATH=${BUILD_DIR}/or1k-elf/bin:${PATH}
PYTHON=${BUILD_DIR}/python-env/bin/python
PYTHON2=${BUILD_DIR}/python2-env/bin/python
BUILD_JOBS=${CI_BUILD_JOBS:-$(nproc)}
if ! [[ "$BUILD_JOBS" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid CI_BUILD_JOBS: $BUILD_JOBS" >&2
    exit 1
fi
if [ "$BUILD_JOBS" -gt 4 ]; then BUILD_JOBS=4; fi
PARALLEL_TESTS=${CI_PARALLEL_TESTS:-1}
if [[ "$PARALLEL_TESTS" != 0 && "$PARALLEL_TESTS" != 1 ]]; then
    echo "CI_PARALLEL_TESTS must be 0 or 1" >&2
    exit 1
fi
TOTAL_START=$SECONDS
echo "CI execution: make_jobs=$BUILD_JOBS parallel_tests=$PARALLEL_TESTS"
echo "Runner CPUs: $(nproc)"



######################################################################
# Section grouping output message helpers
######################################################################

start_test()
{
    echo "::group::=============== $1 $2"
    set -x
}

finish_test()
{
    set +x
    echo "=============== Finished $2"
    echo "::endgroup::"
}


######################################################################
# Check for whitespace errors
######################################################################

start_test check_whitespace "Check whitespace"
./scripts/check_whitespace.sh
finish_test check_whitespace "Check whitespace"


######################################################################
# Run compile tests for several different MCU types
######################################################################

DICTDIR=${BUILD_DIR}/dict
mkdir -p ${DICTDIR}

MCU_START=$SECONDS
CONFIGS=(test/configs/*.config)
for TARGET in "${CONFIGS[@]}" ; do
    start_test mcu_compile "$TARGET"
    make clean
    make distclean
    unset CC
    cp ${TARGET} .config
    make olddefconfig
    make -j"$BUILD_JOBS" V=1
    size out/*.elf
    ./scripts/check-software-div.sh .config out/*.elf
    finish_test mcu_compile "$TARGET"
    cp out/klipper.dict ${DICTDIR}/$(basename ${TARGET} .config).dict
done
MCU_SECONDS=$((SECONDS - MCU_START))


######################################################################
# Verify klippy host software
######################################################################

start_test klippy "Test klippy import (Python3)"
$PYTHON klippy/klippy.py --import-test
finish_test klippy "Test klippy import (Python3)"

start_test klippy "Test klippy import (Python2)"
$PYTHON2 klippy/klippy.py --import-test
finish_test klippy "Test klippy import (Python2)"

# Prepare the shared native library before starting concurrent interpreters.
start_test klippy "Prepare native library (Python 3 and 2)"
$PYTHON klippy/chelper/__init__.py
$PYTHON2 klippy/chelper/__init__.py
finish_test klippy "Prepare native library (Python 3 and 2)"

start_test klippy "Test invoke klippy (Python 3 and 2)"
TESTS=(test/klippy/*.test)
mkdir -p "$BUILD_DIR/test-python3" "$BUILD_DIR/test-python2"
run_suite()
{
    local python=$1 tempdir=$2 started=$SECONDS result=0
    "$python" scripts/test_klippy.py -d "$DICTDIR" -t "$tempdir" \
        "${TESTS[@]}" || result=$?
    echo "Suite finished: $python elapsed=$((SECONDS - started))s status=$result"
    return "$result"
}
REGRESSION_START=$SECONDS
status=0
if [ "$PARALLEL_TESTS" = 1 ]; then
    run_suite "$PYTHON" "$BUILD_DIR/test-python3" \
        > "$BUILD_DIR/python3-tests.log" 2>&1 &
    pid3=$!
    run_suite "$PYTHON2" "$BUILD_DIR/test-python2" \
        > "$BUILD_DIR/python2-tests.log" 2>&1 &
    pid2=$!
    wait "$pid3" || status=1
    wait "$pid2" || status=1
else
    run_suite "$PYTHON" "$BUILD_DIR/test-python3" \
        > "$BUILD_DIR/python3-tests.log" 2>&1 || status=1
    run_suite "$PYTHON2" "$BUILD_DIR/test-python2" \
        > "$BUILD_DIR/python2-tests.log" 2>&1 || status=1
fi
REGRESSION_SECONDS=$((SECONDS - REGRESSION_START))
cat "$BUILD_DIR/python3-tests.log" "$BUILD_DIR/python2-tests.log"
if [ "$status" != 0 ]; then exit "$status"; fi
finish_test klippy "Test invoke klippy (Python 3 and 2)"
summary="jobs=$BUILD_JOBS parallel=$PARALLEL_TESTS configs=${#CONFIGS[@]}"
summary="$summary tests_per_python=${#TESTS[@]} mcu=${MCU_SECONDS}s"
summary="$summary regressions=${REGRESSION_SECONDS}s total=$((SECONDS-TOTAL_START))s"
echo "CI timing: $summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "- CI timing: $summary" >> "$GITHUB_STEP_SUMMARY"
fi
