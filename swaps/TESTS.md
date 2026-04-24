# How to test

## Run local validator & setup environment

1. Start local solana validator
    ```
    solana-test-validator
    ```

2. Set Solana CLI to use local validator
    ```
    solana config set --url http://127.0.0.1:8899
    ```

3. Create a new keypair at ~/mainnet.key (use no password)
    ```
    solana-keygen new --outfile ~/mainnet.key
    ```

4. Airdrop enough funds for deployment to newly created keypair
    ```
    solana airdrop 1000 -k ~/mainnet.key
    ```

## Deploy mocked version of btc-relay program

1. Clone btc-relay program from github
    ```
    git clone -b dev https://github.com/adambor/BTCRelay-Sol
    ```

2. Navigate into BTCRelay-Sol directory
    ```
    cd BTCRelay-Sol
    ```

3. Build btc-relay program with mocked flag (ignore the not used error)
    ```
    anchor build -- --features mocked
    ```

4. Copy the generated program ID into declare_id!() macro in lib.rs
    - Get & copy the program ID
        ```
        solana address -k target/deploy/btc_relay-keypair.json
        ```
    - Open lib.rs &
        ```
        cd programs/btc-relay/src
        nano lib.rs
        ```
    - Find the line starting with declare_id!... and use the copied program ID in the declare_id!() macro
        ```
        declare_id!("<programIdGoesHere>");
        ```
    - Navigate back to repo's root
        ```
        cd ../../../
        ```

5. Copy the generated program ID into Anchor.toml
    - Open file
        ```
        nano Anchor.toml
        ```
    - Set program ID for localnet as such
        ```
        [programs.localnet]
        btc_relay = "<programIdGoesHere>"
        ```

6. Deploy btc-relay program
    ```
    anchor deploy
    ```

## Use btc-relay program ID in swap-program & update the IDL

1. Navigate to swap-program root

2. Update the btc-relay program ID in programs/swap-program/src/utils/btcrelay.rs
    - Open the file
        ```
        nano programs/swap-program/src/utils/btcrelay.rs
        ```
    - Find the line starting with static BTC_RELAY_ID_BASE58: &str and put the btc-relay program ID there
        ```
        static BTC_RELAY_ID_BASE58: &str = "<btcRelayProgramIdGoesHere>";
        ```

3. Copy the btc-relay IDL into tests folder of swap-program
    ```
    cp btc-relay/target/idl/btc-relay.json swap-program/tests/
    ```

## Deploy swap-program

1. Build swap-program
    ```
    anchor build
    ```

2. Copy the generated program ID into declare_id!() macro in lib.rs
    - Get & copy the program ID
        ```
        solana address -k target/deploy/swap_program-keypair.json
        ```
    - Open lib.rs
        ```
        cd programs/swap-program/src
        nano lib.rs
        ```
    - Find the line starting with declare_id!... and use the copied program ID in the declare_id!() macro
        ```
        declare_id!("<programIdGoesHere>");
        ```
    - Navigate back to repo's root
        ```
        cd ../../../
        ```

3. Copy the generated program ID into Anchor.toml
    - Open file
        ```
        nano Anchor.toml
        ```
    - Set program ID for localnet as such
        ```
        [programs.localnet]
        swap_program = "<programIdGoesHere>"
        ```

4. Deploy swap-program
    ```
    anchor deploy
    ```

## Run tests

```
anchor test --skip-local-validator --skip-deploy --skip-build
```


NOTE: As the number of tests is around 600, they are paralelized in batches of 10 (this can be changed by setting a different default value in ParalelizedTest constructor - tests/utils.ts)