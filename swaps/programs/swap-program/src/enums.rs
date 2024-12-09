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
