use anchor_lang::solana_program::hash;

//Reads a varint from the data at a start index
//varint description: https://en.bitcoin.it/wiki/Protocol_documentation#Variable_length_integer
pub fn read_var_int(data: &[u8], start: usize) -> (u64, usize) {
    if data[start] <= 0xFC {
        (data[start] as u64, 1)
    } else if data[start] == 0xFD {
        let val = u16::from_le_bytes(data[(start+1)..(start+3)].try_into().unwrap());
        (val as u64, 3)
    } else if data[start] == 0xFE {
        let val = u32::from_le_bytes(data[(start+1)..(start+5)].try_into().unwrap());
        (val as u64, 5)
    } else {
        let val = u64::from_le_bytes(data[(start+1)..(start+9)].try_into().unwrap());
        (val, 9)
    }
}

pub struct TxOutput<'a> {
    pub value: u64,
    pub script: &'a [u8]
}

pub struct VerifyTransaction<'a> {
    pub version: u32, //Transaction version
    pub out: Option<TxOutput<'a>>, //Filled if the required vout was found, empty if not
    pub locktime: u32, //Transaction locktime
    pub hash: [u8; 32], //Transaction hash
    pub n_sequence: u32 //n_sequence
}

//Verifies important parts of the transaction, while skipping the unecessary parts,
// only works for non-segwit transactions, so segwit data has to be stripped out
// from the tx off-chain
//Format description: https://en.bitcoin.it/wiki/Transaction
pub fn verify_transaction(data: &[u8], vout: u64, verify_nonce: bool) -> Option<VerifyTransaction> {
    
    //Security against spoofing bitcoin txs as merkle tree nodes
    // https://blog.rsk.co/ru/noticia/the-design-of-bitcoin-merkle-trees-reduces-the-security-of-spv-clients/
    if data.len()==64 {
        return None;
    }

    let version = u32::from_le_bytes(data[0..4].try_into().unwrap());

    let mut offset = 4;

    let input_size_resp = read_var_int(data, offset);

    //Check that segwit flag is not set (we only accept non-segwit transactions, or transactions with segwit data stripped)
    if input_size_resp.0 == 0 && input_size_resp.1 == 1 && data[5] == 0x01 {
        return None;
    }

    offset += input_size_resp.1;

    let mut unset = true;
    let mut n_sequence = 0;

    //Parse inputs
    for _i in 0..(input_size_resp.0) {
        //let prev_tx_hash: [u8;32] = data[offset..(offset+32)].try_into().unwrap();
        offset += 32; //UTXO
        //let utxo_index: u32 = u32::from_le_bytes(data[(offset)..(offset+4)].try_into().unwrap());
        offset += 4; //Index
        let input_script_resp = read_var_int(data, offset);
        let total_len = (input_script_resp.0 as usize)+input_script_resp.1;
        offset += total_len; //Script len + script

        //We only care about the nSequence
        let sequence = u32::from_le_bytes(data[(offset)..(offset+4)].try_into().unwrap());
        offset += 4; //Sequence
        if unset {
            //Take the 3 least significant significant bytes as nSequence
            n_sequence = sequence & 0x00FFFFFF;
            unset = false;
        }
        if verify_nonce {
            //https://academy.bit2me.com/en/que-son-los-nsequence/#how-do-nsequence-work?
            //Ensure that every input uses the same nSequence,
            // and the nSequence has no consensus meaning (nSequence>0xEFFFFFFF => first 4 bits set)
            if n_sequence != (sequence & 0x00FFFFFF) || (sequence & 0xF0000000) != 0xF0000000 {
                return None;
            }
        }
    }

    let output_size_resp = read_var_int(data, offset);

    offset += output_size_resp.1;

    let mut out: Option<TxOutput> = None;

    //Parse output
    for i in 0..(output_size_resp.0) {
        if i==vout {
            //We only care about this vout
            let value: u64 = u64::from_le_bytes(data[(offset)..(offset+8)].try_into().unwrap());
            offset += 8; //Value

            let output_script_resp = read_var_int(data, offset);
            offset += output_script_resp.1; //Output script size
            let script_len = output_script_resp.0 as usize;
            let script = &data[offset..(offset+script_len)];
            offset += script_len; //Script

            out = Some(TxOutput {
                value,
                script
            });
        } else {
            //let value: u64 = u64::from_le_bytes(data[(offset)..(offset+8)].try_into().unwrap());
            offset += 8; //Value
            let output_script_resp = read_var_int(data, offset);

            offset += output_script_resp.1; //Output script size
            let script_len = output_script_resp.0 as usize;
            //let script = &data[offset..(offset+script_len)];
            offset += script_len; //Script
        }
    }

    let locktime = u32::from_le_bytes(data[offset..(offset+4)].try_into().unwrap());

    //Double sha256 hash of the tx data
    let hash: [u8; 32] = hash::hash(&hash::hash(data).to_bytes()).to_bytes();

    Some(VerifyTransaction {
        version,
        out,
        n_sequence,
        locktime,
        hash
    })

}
