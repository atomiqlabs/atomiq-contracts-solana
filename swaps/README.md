# SolLightning swap program

A universal swap program handling HTLC (hash-time locked contracts) and PTLC (proof-time locked contracts - with the help of [BTCRelay](https://github.com/adambor/BTCRelay-Sol)).

This program is utilized by [SolLightning-intermediary](https://github.com/adambor/SolLightning-Intermediary) and [SolLightning-sdk](https://github.com/adambor/SolLightning-sdk) to perform trustless BTC <-> Solana swaps.

## Parties
For each contract there are always 2 parties:
- offerer, the one offering spl tokens either for:
    - the knowledge of secret S (for HTLCs)
    - the proof of transaction being sent on bitcoin chain (for PTLCs)
- claimer, the one wishing to claim the spl tokens for:
    - his knowledge of secret S (for HTLCs)
    - a proof that he sent a valid bitcoin transaction to desired address and with desired amount (for PTLCs)

## "Meta transactions"
Allows for initialization of HTLCs and PTLCs with "meta transactions", the offerer can just send a __signed message Mi (initialize)__ to claimer and then the transaction fees for broadcasting the transaction and creating a contract PDA are paid by the claimer (incentivizing the claimer to conclude the swap in timely manner, as his solana is locked up in a PDA for the time of the swap).

## HTLC (hash-time locked contract)
A contract, where claimer needs to provide a valid __secret S__, such that __hash of a secret H(S)__ equals __payment hash P__, in under __locktime T__ to claim the funds. Otherwise offerer can claim his funds back from the contract after __locktime T__ or after claimer sends him a specific __signed message Mr (refund)__ (for cooperative close).

## PTLC (proof-time locked contract)
Contract similar to HTLC (hash-time locked contract), where claimer needs to provide a proof instead of a secret for a hash. In this case the proof is transaction verification through bitcoin relay.

## Locktime
Currently the source of time is the Solana on-chain time, however that might be skewed at times and run behind for some time (as is the case after cluster goes down).

As expiry time for lightning invoices and atomic swaps on bitcoin is expresed in terms of bitcoin blockheight, a better approach will be to use the same time-chain with the help of BTCRelay, and express locktime in terms of bitcoin blockheight. This would allow for much tighter tolerances, leading to shorter locktimes, all the while increasing security and success rate of the swaps. 
