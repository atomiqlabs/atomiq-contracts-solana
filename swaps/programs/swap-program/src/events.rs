use anchor_lang::prelude::*;
use crate::{SwapType, ClaimHandlerType, RefundHandlerType};

#[event]
pub struct InitializeEvent {
    pub hash: [u8; 32],
    pub txo_hash: [u8; 32],
    pub nonce: u64,
    pub kind: SwapType,
    pub sequence: u64
}

#[event]
pub struct RefundEvent {
    pub hash: [u8; 32],
    pub sequence: u64
}

#[event]
pub struct ClaimEvent {
    pub hash: [u8; 32],
    pub secret: [u8; 32],
    pub sequence: u64
}

#[event]
pub struct EscrowInitializeEvent {
    pub offerer: Pubkey,
    pub claimer: Pubkey,
    pub escrow_hash: [u8; 32],
    pub claim_handler: ClaimHandlerType,
    pub refund_handler: RefundHandlerType,
}

#[event]
pub struct EscrowClaimEvent {
    pub offerer: Pubkey,
    pub claimer: Pubkey,
    pub escrow_hash: [u8; 32],
    pub claim_handler: ClaimHandlerType,
    pub witness_result: [u8; 32],
}

#[event]
pub struct EscrowRefundEvent {
    pub offerer: Pubkey,
    pub claimer: Pubkey,
    pub escrow_hash: [u8; 32],
    pub refund_handler: RefundHandlerType,
    pub witness_result: [u8; 32],
}

#[event]
pub struct EscrowExecutionErrorEvent {
    pub escrow_hash: [u8; 32],
    pub error: [u8; 32],
}
