use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum SwapType {
    Htlc = 0,
    Chain = 1,
    ChainNonced = 2,
    ChainTxhash = 3
}
pub const SWAP_TYPE_COUNT: usize = 4;

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum ClaimHandlerType {
    Hashlock = 0,
    BitcoinOutput = 1,
    BitcoinNoncedOutput = 2,
    BitcoinTxid = 3,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum RefundHandlerType {
    Timelock = 0,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Eq)]
#[repr(u8)]
pub enum EscrowLifecycleState {
    NotCommitted = 0,
    Committed = 1,
    Claimed = 2,
    Refunded = 3,
}

impl From<SwapType> for ClaimHandlerType {
    fn from(value: SwapType) -> Self {
        match value {
            SwapType::Htlc => ClaimHandlerType::Hashlock,
            SwapType::Chain => ClaimHandlerType::BitcoinOutput,
            SwapType::ChainNonced => ClaimHandlerType::BitcoinNoncedOutput,
            SwapType::ChainTxhash => ClaimHandlerType::BitcoinTxid,
        }
    }
}
