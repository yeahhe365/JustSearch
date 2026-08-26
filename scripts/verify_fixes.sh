#!/usr/bin/env bash
# JustSearch 修复后一键验证：编译检查 + 全量 pytest + 前端测试 + 构建。
# 用法: bash scripts/verify_fixes.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0

echo "=== [1/4] Python 编译检查 ==="
if ./venv/bin/python -m compileall -q backend/app; then
    echo "OK: compileall"
else
    echo "FAIL: compileall"; FAIL=1
fi

echo "=== [2/4] 全量 pytest ==="
if ./venv/bin/python -m pytest tests -q --tb=short -p no:cacheprovider; then
    echo "OK: pytest"
else
    echo "FAIL: pytest"; FAIL=1
fi

echo "=== [3/4] 前端 node 测试 ==="
if npm run test:frontend; then
    echo "OK: frontend tests"
else
    echo "FAIL: frontend tests"; FAIL=1
fi

echo "=== [4/4] 前端构建 ==="
if npm run build; then
    echo "OK: build"
else
    echo "FAIL: build"; FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "✅ 全部验证通过"
else
    echo "❌ 存在失败项，请查看上方日志"
fi
exit "$FAIL"
