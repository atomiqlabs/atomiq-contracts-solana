use anchor_lang::{
    prelude::*, 
    solana_program::clock,
    solana_program::hash,
};
use anchor_spl::token::{
    Mint,
    TokenAccount
};

use crate::enums::*;
use crate::errors::*;
use crate::state::*;
use crate::events::*;
use crate::structs::*;

fn now_ts() -> Result<u64> {
    Ok(clock::Clock::get().unwrap().unix_timestamp.try_into().unwrap())
}

fn now_slot() -> Result<u64> {
    Ok(clock::Clock::get().unwrap().slot)
}

fn compute_escrow_hash(
    offerer: &Pubkey,
    claimer: &Pubkey,
    mint: &Pubkey,
    swap_data: &SwapData,
    security_deposit: u64,
    claimer_bounty: u64,
    success_action_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let mut payload = Vec::with_capacity(256);
    payload.extend_from_slice(offerer.as_ref());
    payload.extend_from_slice(claimer.as_ref());
    payload.extend_from_slice(mint.as_ref());
    payload.extend_from_slice(&swap_data.try_to_vec()?);
    payload.extend_from_slice(&security_deposit.to_le_bytes());
    payload.extend_from_slice(&claimer_bounty.to_le_bytes());
    payload.extend_from_slice(success_action_commitment);
    Ok(hash::hash(&payload).to_bytes())
}

#[allow(clippy::too_many_arguments)]
pub fn process_initialize(
    escrow_state: &mut Account<EscrowState>,
    offerer: &AccountInfo,
    claimer: &AccountInfo,
    claimer_ata: Option<&Account<TokenAccount>>,
    mint: &Account<Mint>,

    swap_data: &SwapData,
    
    txo_hash: [u8; 32], //Only for on-chain,
    auth_expiry: u64,
    security_deposit: u64,
    claimer_bounty: u64,
    success_action_commitment: [u8; 32],
) -> Result<()> {
    require!(
        auth_expiry > now_ts()?,
        SwapErrorCode::AuthExpired
    );

    require!(
        swap_data.confirmations <= crate::MAX_CONFIRMATIONS,
        SwapErrorCode::TooManyConfirmations
    );

    if swap_data.kind != SwapType::ChainNonced {
        require!(
            swap_data.nonce == 0,
            SwapErrorCode::InvalidSwapDataNonce
        );
    }

    require!(
        escrow_state.lifecycle_state == EscrowLifecycleState::NotCommitted,
        SwapErrorCode::EscrowAlreadyCommitted
    );

    escrow_state.data = swap_data.clone();

    escrow_state.offerer = *offerer.key;
    escrow_state.claimer = *claimer.to_account_info().key;

    if swap_data.pay_out {
        let claimer_ata = claimer_ata.expect("Claimer ATA not provided for pay_out=true swap");
        escrow_state.claimer_ata = *claimer_ata.to_account_info().key;
    }
    escrow_state.mint = *mint.to_account_info().key;
    escrow_state.security_deposit = security_deposit;
    escrow_state.claimer_bounty = claimer_bounty;
    escrow_state.claim_handler = swap_data.kind.into();
    escrow_state.refund_handler = RefundHandlerType::Timelock;
    escrow_state.success_action_commitment = success_action_commitment;
    escrow_state.lifecycle_state = EscrowLifecycleState::Committed;
    escrow_state.init_slot = now_slot()?;
    escrow_state.finish_slot = 0;
    escrow_state.escrow_hash = compute_escrow_hash(
        offerer.key,
        claimer.key,
        mint.to_account_info().key,
        swap_data,
        security_deposit,
        claimer_bounty,
        &success_action_commitment,
    )?;

    emit!(InitializeEvent {
        hash: swap_data.hash,
        txo_hash,
        nonce: swap_data.nonce,
        kind: swap_data.kind,
        sequence: swap_data.sequence
    });

    emit!(EscrowInitializeEvent {
        offerer: escrow_state.offerer,
        claimer: escrow_state.claimer,
        escrow_hash: escrow_state.escrow_hash,
        claim_handler: escrow_state.claim_handler,
        refund_handler: escrow_state.refund_handler,
    });

    Ok(())
}
