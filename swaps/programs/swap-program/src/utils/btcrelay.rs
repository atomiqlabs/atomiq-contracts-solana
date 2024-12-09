use anchor_lang::{
    prelude::*,
    solana_program::instruction::Instruction
};
use std::str::FromStr;
use crate::SwapErrorCode;

const BTC_RELAY_ID_BASE58: &str = "3KHSHFpEK6bsjg3bqcxQ9qssJYtRCMi2S9TYVe4q6CQc";
const TX_VERIFY_IX_PREFIX: [u8; 8] = [
    0x9d,
    0x7e,
    0xc1,
    0x86,
    0x31,
    0x33,
    0x07,
    0x58
];
const BLOCKHEIGHT_IX_PREFIX: [u8; 8] = [
    0xd3,
    0xdc,
    0xd0,
    0x97,
    0x3d,
    0xae,
    0xec,
    0xea
];

// Checks if current transaction includes an instruction calling verify_transaction on btcrelay program
// Returns 0 on success, and positive integer on failure
pub fn verify_tx_ix(ix: &Instruction, reversed_tx_id: &[u8; 32], confirmations: u32) -> Result<()> {
    let btc_relay_id: Pubkey = Pubkey::from_str(BTC_RELAY_ID_BASE58).unwrap();

    if  ix.program_id       != btc_relay_id
    {
        return Err(anchor_lang::error!(SwapErrorCode::InvalidTxVerifyProgramId));
    }

    check_tx_data(&ix.data, reversed_tx_id, confirmations)
}

// Verify serialized BtcRelay instruction data
pub fn check_tx_data(data: &[u8], reversed_tx_id: &[u8; 32], confirmations: u32) -> Result<()> {
    for i in 0..8 {
        if data[i] != TX_VERIFY_IX_PREFIX[i] {
            return Err(anchor_lang::error!(SwapErrorCode::InvalidTxVerifyIx));
        }
    }
    for i in 8..40 {
        if data[i] != reversed_tx_id[i-8] {
            return Err(anchor_lang::error!(SwapErrorCode::InvalidTxVerifyTxid));
        }
    }

    let _confirmations = u32::from_le_bytes(data[40..44].try_into().unwrap());
    if confirmations != _confirmations {
        return Err(anchor_lang::error!(SwapErrorCode::InvalidTxVerifyConfirmations));
    }

    Ok(())
}

// Checks current blockheight, by checking if the tx includes an instruction calling verify_transaction on btcrelay program
// Returns 0 on success, and positive integer on failure
//
// Verifies blockheight of the main chain
// Supports many operators
//  0 - blockheight has to be < value
//  1 - blockheight has to be <= value
//  2 - blockheight has to be > value
//  3 - blockheight has to be >= value
//  4 - blockheight has to be == value
pub fn verify_blockheight_ix(ix: &Instruction, blockheight: u32, operation: u32) -> Result<()> {
    let btc_relay_id: Pubkey = Pubkey::from_str(BTC_RELAY_ID_BASE58).unwrap();

    if  ix.program_id       != btc_relay_id
    {
        return Err(anchor_lang::error!(SwapErrorCode::InvalidBlockheightVerifyProgramId));
    }

    check_blockheight_data(&ix.data, blockheight, operation)
}

// Verify serialized BtcRelay instruction data
pub fn check_blockheight_data(data: &[u8], blockheight: u32, operation: u32) -> Result<()> {
    for i in 0..8 {
        if data[i] != BLOCKHEIGHT_IX_PREFIX[i] {
            return Err(anchor_lang::error!(SwapErrorCode::InvalidBlockheightVerifyIx));
        }
    }

    let _blockheight = u32::from_le_bytes(data[8..12].try_into().unwrap());
    if blockheight != _blockheight {
        return Err(anchor_lang::error!(SwapErrorCode::InvalidBlockheightVerifyHeight));
    }

    let _operation = u32::from_le_bytes(data[12..16].try_into().unwrap());
    if operation != _operation {
        return Err(anchor_lang::error!(SwapErrorCode::InvalidBlockheightVerifyOperation));
    }

    Ok(())
}
