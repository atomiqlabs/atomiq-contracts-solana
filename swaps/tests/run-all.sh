#!/usr/bin/env bash
set -euo pipefail

yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/instructions/deposit.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/instructions/withdraw.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/instructions/initialize.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/instructions/claim.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/instructions/v2.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/instructions/refund.ts
