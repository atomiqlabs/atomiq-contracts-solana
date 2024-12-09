import { TransactionError } from "@solana/web3.js";
import { Program, workspace, LangErrorCode } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";

const program = workspace.SwapProgram as Program<SwapProgram>;
export type SwapProgramError = typeof program.idl.errors[number]["name"];
export type AnchorErrorCodes = keyof typeof LangErrorCode;

export type CombinedProgramErrorType = SwapProgramError | AnchorErrorCodes | "ProgramError" | "UNDEFINED" | "AccountAlreadyInitialized";

export function parseSwapProgramError(instructionIndex: number, _error: TransactionError): CombinedProgramErrorType {

    if(_error==null) return null;

    const error = _error as any;
    if(error.InstructionError==null) return "UNDEFINED";
    if(error.InstructionError[0]!=instructionIndex) return "UNDEFINED";
    if(error.InstructionError[1]==="ProgramFailedToComplete") return "ProgramError";
    if(error.InstructionError[1].Custom==null) return "UNDEFINED";

    const errorCode: number = error.InstructionError[1].Custom;

    const programError: SwapProgramError = program.idl.errors.find(e => e.code===errorCode)?.name;
    if(programError!=null) return programError;

    for(let key in LangErrorCode) {
        if(LangErrorCode[key]===errorCode) return key as AnchorErrorCodes;
    }

    if(errorCode===0x0) return "AccountAlreadyInitialized";

    return "UNDEFINED";

}