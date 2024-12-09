use anchor_lang::{
    prelude::*, 
    solana_program::clock, 
    solana_program::sysvar::instructions::ID as IX_ID,
    system_program
};
use anchor_spl::token::{
    self, /*CloseAccount, */ Mint, Token,
    TokenAccount, Transfer
};
use std::cmp;

use enums::*;
use errors::*;
use state::*;
use instructions::*;
use structs::*;

mod enums;
mod errors;
mod state;
mod events;
mod instructions;
mod structs;

mod utils;
mod ixs;

declare_id!("4hfUykhqmD7ZRvNh1HuzVKEY7ToENixtdUKZspNDCrEM");

pub fn now_ts() -> Result<u64> {
    Ok(clock::Clock::get().unwrap().unix_timestamp.try_into().unwrap())
}

const AUTHORITY_SEED: &[u8] = b"authority";
const USER_DATA_SEED: &[u8] = b"uservault";
const BLOCKHEIGHT_EXPIRY_THRESHOLD: u64 = 1000000000; //If expiry is < BLOCKHEIGHT_EXPIRY_THRESHOLD it is considered as expressed in blockheight instead of timestamp

const BTCRELAY_PRUNING_FACTOR: u16 = 250;
const BTCRELAY_SAFETY_BUFFER: u16 = 50;
const MAX_CONFIRMATIONS: u16 = BTCRELAY_PRUNING_FACTOR - BTCRELAY_SAFETY_BUFFER;

#[program]
pub mod swap_program {
    use super::*;

    //Deposit to program balance
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
    ) -> Result<()> {
        token::transfer(
            ctx.accounts.get_transfer_to_vault_context(),
            amount,
        )?;
        
        ctx.accounts.user_data.bump = ctx.bumps.user_data;
        ctx.accounts.user_data.amount += amount;

        Ok(())
    }

    //Withdraw from program balance
    pub fn withdraw(
        ctx: Context<Withdraw>,
        amount: u64,
    ) -> Result<()> {
        let authority_seeds = &[AUTHORITY_SEED, &[ctx.bumps.vault_authority]];

        if amount>0 {
            token::transfer(
                ctx.accounts
                    .get_transfer_to_signer_context()
                    .with_signer(&[&authority_seeds[..]]),
                amount,
            )?;
        }

        ctx.accounts.user_data.amount -= amount;

        Ok(())
    }

    //Initialize from external source
    pub fn offerer_initialize_pay_in(
        ctx: Context<InitializePayIn>,
        swap_data: SwapData,
        txo_hash: [u8; 32], //Only for on-chain,
        auth_expiry: u64
    ) -> Result<()> {

        require!(
            swap_data.pay_in,
            SwapErrorCode::InvalidSwapDataPayIn
        );

        ixs::initialize::process_initialize(
            &mut ctx.accounts.escrow_state,
            &ctx.accounts.offerer.to_account_info(),
            &ctx.accounts.claimer,
            &ctx.accounts.claimer_ata,
            &ctx.accounts.mint,
            &swap_data,
            txo_hash,
            auth_expiry,
        )?;

        ctx.accounts.escrow_state.offerer_ata = *ctx.accounts.offerer_ata.to_account_info().key;
        token::transfer(
            ctx.accounts.get_transfer_to_pda_context(),
            ctx.accounts.escrow_state.data.amount,
        )?;

        Ok(())
    }

    //Initialize from internal program balance.
    //Signer (claimer), must also deposit a required security_deposit,
    // in case he doesn't claim the swap in time and offerer has to refund,
    // offerer will get this deposit as a compensation for the time value
    // of funds locked up in a contract
    //Signer (claimer), may also deposit a claimer_bounty, to incentivize
    // watchtowers to claim this contract (only SwapType::Chain* swaps)
    pub fn offerer_initialize(
        ctx: Context<Initialize>,
        swap_data: SwapData,
        security_deposit: u64,
        claimer_bounty: u64,
        txo_hash: [u8; 32], //Only for on-chain
        auth_expiry: u64
    ) -> Result<()> {

        require!(
            !swap_data.pay_in,
            SwapErrorCode::InvalidSwapDataPayIn
        );

        ixs::initialize::process_initialize(
            &mut ctx.accounts.escrow_state,
            &ctx.accounts.offerer.to_account_info(),
            &ctx.accounts.claimer,
            &ctx.accounts.claimer_ata,
            &ctx.accounts.mint,
            &swap_data,
            txo_hash,
            auth_expiry,
        )?;

        //We can calculate only the maximum of the two, not a sum,
        // since only one of them can ever be paid out:
        // swap success - security_deposit goes back to claimer, claimer_bounty is paid to watchtower
        // swap failed - claimer_bounty goes back to claimer, security_deposit is paid to offerer
        let required_lamports = cmp::max(security_deposit, claimer_bounty);

        //There is already some amount of lamports in the PDA, required for rent exemption
        //Only deposit more if it's required
        let dst_starting_lamports = ctx.accounts.escrow_state.to_account_info().lamports();
        if dst_starting_lamports < required_lamports {
            let difference = required_lamports - dst_starting_lamports;
            let cpi_program = ctx.accounts.system_program.to_account_info();
            let transfer_lamports_instruction = system_program::Transfer{
                from: ctx.accounts.claimer.to_account_info(),
                to: ctx.accounts.escrow_state.to_account_info()
            };
            let cpi_ctx = CpiContext::new(cpi_program, transfer_lamports_instruction);
            system_program::transfer(cpi_ctx, difference)?;
        }
        
        ctx.accounts.escrow_state.security_deposit = security_deposit;
        ctx.accounts.escrow_state.claimer_bounty = claimer_bounty;

        ctx.accounts.offerer_user_data.amount -= swap_data.amount;

        Ok(())
    }

    //Refund back to offerer once enough time has passed,
    // or by providing a "refund" message signed by claimer
    pub fn offerer_refund(ctx: Context<Refund>, auth_expiry: u64) -> Result<()> {
        let is_cooperative = ixs::refund::process_refund(auth_expiry, &ctx.accounts.escrow_state, &ctx.accounts.ix_sysvar, &mut ctx.accounts.claimer_user_data)?;

        //Refund to internal wallet
        ctx.accounts.offerer_user_data.amount += ctx.accounts.escrow_state.data.amount;

        ixs::refund::pay_security_deposit(&mut ctx.accounts.escrow_state, &mut ctx.accounts.offerer, &mut ctx.accounts.claimer, is_cooperative)?;

        Ok(())
    }

    //Refund back to offerer once enough time has passed,
    // or by providing a "refund" message signed by claimer
    pub fn offerer_refund_pay_in(ctx: Context<RefundPayIn>, auth_expiry: u64) -> Result<()> {
        let is_cooperative = ixs::refund::process_refund(auth_expiry, &ctx.accounts.escrow_state, &ctx.accounts.ix_sysvar, &mut ctx.accounts.claimer_user_data)?;

        //Refund in token to external wallet
        let authority_seeds = &[AUTHORITY_SEED, &[ctx.bumps.vault_authority]];

        token::transfer(
            ctx.accounts
                .get_transfer_to_initializer_context()
                .with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_state.data.amount,
        )?;

        ixs::refund::pay_security_deposit(&mut ctx.accounts.escrow_state, &mut ctx.accounts.offerer, &mut ctx.accounts.claimer, is_cooperative)?;

        Ok(())
    }

    //Claim the swap using the "secret", or data in the provided "data" account
    pub fn claimer_claim(ctx: Context<Claim>, secret: Vec<u8>) -> Result<()> {
        ixs::claim::process_claim(&ctx.accounts.signer, &ctx.accounts.escrow_state.data, &ctx.accounts.ix_sysvar, &mut ctx.accounts.data, &secret)?;

        let user_data = &mut ctx.accounts.claimer_user_data;
        user_data.amount += ctx.accounts.escrow_state.data.amount;
        user_data.success_volume[ctx.accounts.escrow_state.data.kind as usize] = user_data.success_volume[ctx.accounts.escrow_state.data.kind as usize].saturating_add(ctx.accounts.escrow_state.data.amount);
        user_data.success_count[ctx.accounts.escrow_state.data.kind as usize] = user_data.success_count[ctx.accounts.escrow_state.data.kind as usize].saturating_add(1);

        ixs::claim::pay_claimer_bounty(&ctx.accounts.signer, &ctx.accounts.initializer, &ctx.accounts.escrow_state)?;

        Ok(())
    }

    //Claim the swap using the "secret", or data in the provided "data" account
    pub fn claimer_claim_pay_out(ctx: Context<ClaimPayOut>, secret: Vec<u8>) -> Result<()> {
        ixs::claim::process_claim(&ctx.accounts.signer, &ctx.accounts.escrow_state.data, &ctx.accounts.ix_sysvar, &mut ctx.accounts.data, &secret)?;

        let authority_seeds = &[AUTHORITY_SEED, &[ctx.bumps.vault_authority]];

        token::transfer(
            ctx.accounts
                .get_transfer_to_claimer_context()
                .with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_state.data.amount,
        )?;

        ixs::claim::pay_claimer_bounty(&ctx.accounts.signer, &ctx.accounts.initializer, &ctx.accounts.escrow_state)?;

        Ok(())
    }

    //Initializes the data account, by writting signer's key to it
    pub fn init_data(ctx: Context<InitData>) -> Result<()> {
        require!(
            ctx.accounts.data.is_writable,
            SwapErrorCode::InvalidAccountWritability
        );

        let mut acc_data = ctx.accounts.data.try_borrow_mut_data()?;
        acc_data[0..32].copy_from_slice(&ctx.accounts.signer.key.to_bytes());

        Ok(())
    }

    //Initializes chunk of data to the data account
    pub fn write_data(ctx: Context<WriteDataAlt>, start: u32, data: Vec<u8>) -> Result<()> {
        require!(
            ctx.accounts.data.is_writable,
            SwapErrorCode::InvalidAccountWritability
        );

        //Check signer key matches
        let mut acc_data = ctx.accounts.data.try_borrow_mut_data()?;
        require!(
            acc_data[0..32]==ctx.accounts.signer.key.to_bytes(),
            SwapErrorCode::InvalidUserData
        );

        acc_data[((start+32) as usize)..(((start+32) as usize)+data.len())].copy_from_slice(&data);

        Ok(())
    }
    
    //Closes data account
    pub fn close_data(ctx: Context<CloseDataAlt>) -> Result<()> {
        require!(
            ctx.accounts.data.is_writable,
            SwapErrorCode::InvalidAccountWritability
        );

        //Check signer key matches
        let acc_data = ctx.accounts.data.try_borrow_data()?;
        require!(
            acc_data[0..32]==ctx.accounts.signer.key.to_bytes(),
            SwapErrorCode::InvalidUserData
        );

        let mut acc_balance = ctx.accounts.data.try_borrow_mut_lamports()?;
        let balance: u64 = **acc_balance;
        **acc_balance = 0;

        let mut signer_balance = ctx.accounts.signer.try_borrow_mut_lamports()?;
        **signer_balance += balance;

        Ok(())
    }
}
