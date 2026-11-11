// One-step market-price purchases from AssetHub, over XCM. The buyer's EVM wallet makes a single
// call to AssetHub's XCM precompile, which runs this program with the buyer's own account as origin:
//
//   SetFeesMode { jit_withdraw: true }        delivery fee (DOT) comes straight from the buyer
//   TransferReserveAsset { USDT amount, Xode,
//     BuyExecution { USDT, Unlimited }         Xode's fee (0.01 USDT + weight); the rest stays
//     SetAppendix [ DepositAsset { all, beneficiary } ]
//                                             runs last, even on error: XON - or the USDT, if the
//                                             swap failed - goes to the beneficiary on Xode
//     ExchangeAsset { all USDT -> >= minimum XON, maximal }
//     SetTopic(topic)                          the message id on Xode, to find the outcome
//   }
//
// Nobody else holds the USDT at any point: it moves from the buyer to Xode's reserve account on
// AssetHub and is swapped on Xode's DEX on arrival, in the same message. There's no gateway, no
// relayer attestation and no USDT inventory to pre-fund. A failed swap (minimum not met, swaps
// paused, pool pending) leaves the buyer the USDT on Xode, less Xode's fee.
//
// The bytes are SCALE-encoded `VersionedXcm::V5`, hand-encoded because only the amounts, para id,
// beneficiary and topic vary. They are pinned to what AssetHub itself produced (see
// test/unit/xcmSwap.test.ts), and the runtime's tests run the forwarded message byte for byte.

import { ethers } from "ethers";

/// pallet-xcm's precompile, at the same fixed address on every chain that has it.
export const XCM_PRECOMPILE = "0x00000000000000000000000000000000000A0000";
export const XCM_PRECOMPILE_ABI = [
  "function execute(bytes message, (uint64 refTime, uint64 proofSize) weight)",
  "function weighMessage(bytes message) view returns ((uint64 refTime, uint64 proofSize) weight)",
];
export const xcmPrecompile = new ethers.Interface(XCM_PRECOMPILE_ABI);

/// Xode's parachain id on Polkadot.
export const XODE_PARA_ID = 3417;
/// USDT on AssetHub: pallet-assets (instance 50) asset 1984.
export const USDT_ASSET_ID = 1984;
/// What Xode takes from the USDT for executing the message: a flat 0.01 USDT plus 0.01 USDT per
/// second of weight for 7 instructions at 1e9 each (Xode's `weight_trader.rs`). Only quotes use it
/// - BuyExecution offers the whole amount and Xode takes what it charges, so a fee change can't
/// strand anything; at worst the swap gets a little less and the minimum decides.
export const XCM_SWAP_FEE = 10_070n;
/// The smallest purchase: a failed swap's leftover (amount less Xode's fee) must stay above USDT's
/// 0.01 minimum balance on Xode, or the executor drops it. 0.1 USDT leaves a wide margin.
export const XCM_SWAP_MIN_USDT = 100_000n;
/// XON's 12-decimal planck as Solidity (and the API's amounts) see it: 1 planck = 1e6 wei.
export const PLANCK_TO_WEI = 1_000_000n;
/// Most weight a prepared call may ask for (refTime / proofSize). AssetHub weighs the program at
/// ~0.63e9 / ~10k; anything far above that isn't this program.
export const MAX_SWAP_WEIGHT = { refTime: 10_000_000_000n, proofSize: 1_000_000n };

export interface XcmSwapParams {
  /// Raw USDT units (6 decimals).
  usdtAmount: bigint;
  /// XON planck (12 decimals) - the least the swap may return.
  minXonPlanck: bigint;
  /// The AccountId32 on Xode that receives the XON (or the USDT, if the swap fails), 0x + 64 hex.
  beneficiaryAccount: string;
  /// 0x + 64 hex.
  topic: string;
  paraId: number;
}

// --- SCALE ------------------------------------------------------------------------------------

const U128_MAX = (1n << 128n) - 1n;

export function compact(value: bigint): string {
  if (value < 0n || value > U128_MAX) throw new RangeError(`compact out of range: ${value}`);
  const le = (v: bigint, bytes: number) => {
    let out = "";
    for (let i = 0; i < bytes; i++) out += Number((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
    return out;
  };
  if (value < 1n << 6n) return le(value << 2n, 1);
  if (value < 1n << 14n) return le((value << 2n) | 1n, 2);
  if (value < 1n << 30n) return le((value << 2n) | 2n, 4);
  let len = 4;
  while (value >> BigInt(8 * len) !== 0n) len++;
  return le(BigInt(((len - 4) << 2) | 3), 1) + le(value, len);
}

/// Reads a compact integer at `offset` (in bytes) of `hex` (no 0x); returns it and the next offset.
/// Only the canonical (shortest) encoding is accepted, so each value has exactly one byte string.
function readCompact(hex: string, offset: number): [bigint, number] {
  const byte = (i: number) => {
    const s = hex.slice(2 * i, 2 * i + 2);
    if (s.length !== 2) throw new Error("truncated");
    return BigInt(parseInt(s, 16));
  };
  const first = byte(offset);
  const mode = first & 3n;
  let value: bigint;
  let next: number;
  if (mode === 0n) {
    value = first >> 2n;
    next = offset + 1;
  } else if (mode === 1n) {
    value = (first | (byte(offset + 1) << 8n)) >> 2n;
    next = offset + 2;
  } else if (mode === 2n) {
    value = (first | (byte(offset + 1) << 8n) | (byte(offset + 2) << 16n) | (byte(offset + 3) << 24n)) >> 2n;
    next = offset + 4;
  } else {
    const len = Number(first >> 2n) + 4;
    if (len > 16) throw new Error("compact too long");
    value = 0n;
    for (let i = 0; i < len; i++) value |= byte(offset + 1 + i) << BigInt(8 * i);
    next = offset + 1 + len;
  }
  if (compact(value) !== hex.slice(2 * offset, 2 * next)) throw new Error("non-canonical compact");
  return [value, next];
}

const strip = (hex: string) => (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();

function bytes32(value: string, what: string): string {
  if (!ethers.isHexString(value, 32)) throw new Error(`${what} must be 0x followed by 64 hex characters`);
  return strip(value);
}

// Fixed pieces, named after what they encode.
const USDT_HERE = "0002043205" + compact(BigInt(USDT_ASSET_ID)); //            {0, [PalletInstance(50), GeneralIndex(1984)]}
const USDT_FROM_XODE = "0103" + "00" + compact(1000n) + "043205" + compact(BigInt(USDT_ASSET_ID)); // {1, [Parachain(1000), PalletInstance(50), GeneralIndex(1984)]}
const FUNGIBLE = "00";

/// The 4 instructions that run on Xode, without their length prefix.
function programOnXode(p: XcmSwapParams): string {
  if (p.usdtAmount <= 0n) throw new Error("usdtAmount must be positive");
  if (p.minXonPlanck <= 0n) throw new Error("minXonPlanck must be positive");
  const beneficiary = "00" + "01" + "01" + "00" + bytes32(p.beneficiaryAccount, "beneficiaryAccount"); // {0, X1[AccountId32 { network: None, id }]}
  return (
    "13" + USDT_FROM_XODE + FUNGIBLE + compact(p.usdtAmount) + "00" + // BuyExecution { fees: all the USDT, weight_limit: Unlimited }
    "16" + "04" + "0d" + "0102" + compact(2n) + beneficiary + //        SetAppendix([DepositAsset { Wild(AllCounted(2)), beneficiary }])
    "0f" + "0101" + USDT_FROM_XODE + "00" + //                           ExchangeAsset { give: Wild(AllOf { USDT, WildFungible }),
    "04" + "0000" + FUNGIBLE + compact(p.minXonPlanck) + "01" + //         want: [(XON {0, Here}, minimum)], maximal: true }
    "2c" + bytes32(p.topic, "topic") //                                  SetTopic(topic)
  );
}

/// The program the buyer's wallet hands AssetHub's XCM precompile, 0x-prefixed.
export function encodeXcmSwap(p: XcmSwapParams): string {
  if (!Number.isInteger(p.paraId) || p.paraId < 0 || p.paraId > 0xffffffff) throw new Error("bad paraId");
  return (
    "0x" +
    "05" + "08" + //                                                   V5, 2 instructions
    "2b" + "01" + //                                                   SetFeesMode { jit_withdraw: true }
    "05" + "04" + USDT_HERE + FUNGIBLE + compact(p.usdtAmount) + //     TransferReserveAsset { assets: [(USDT, amount)],
    "0101" + "00" + compact(BigInt(p.paraId)) + //                        dest: {1, [Parachain(paraId)]},
    "10" + programOnXode(p) //                                            xcm: 4 instructions }
  );
}

/// What Xode receives - AssetHub puts ReserveAssetDeposited + ClearOrigin in front - 0x-prefixed,
/// for dry-running it on Xode before the buyer signs.
export function encodeXcmSwapOnXode(p: XcmSwapParams): string {
  return (
    "0x" +
    "05" + "18" + //                                                   V5, 6 instructions
    "01" + "04" + USDT_FROM_XODE + FUNGIBLE + compact(p.usdtAmount) + // ReserveAssetDeposited([(USDT, amount)])
    "0a" + //                                                          ClearOrigin
    programOnXode(p)
  );
}

/// The inverse of `encodeXcmSwap`: the parameters, if `message` is exactly that program (every
/// byte other than the parameters fixed), else null. Anything else - another instruction, asset,
/// destination shape, beneficiary shape, a trailing byte - is refused.
export function decodeXcmSwap(message: string): XcmSwapParams | null {
  try {
    if (!ethers.isHexString(message)) return null;
    const hex = strip(message);
    let at = 0; // bytes
    const expect = (fixed: string) => {
      if (hex.slice(2 * at, 2 * at + fixed.length) !== fixed) throw new Error("mismatch");
      at += fixed.length / 2;
    };
    const take32 = () => {
      const value = hex.slice(2 * at, 2 * at + 64);
      if (value.length !== 64) throw new Error("truncated");
      at += 32;
      return "0x" + value;
    };
    const num = () => {
      const [value, next] = readCompact(hex, at);
      at = next;
      return value;
    };

    expect("0508" + "2b01" + "0504" + USDT_HERE + FUNGIBLE);
    const usdtAmount = num();
    expect("010100");
    const paraId = num();
    expect("10" + "13" + USDT_FROM_XODE + FUNGIBLE);
    if (num() !== usdtAmount) return null;
    expect("00" + "16" + "04" + "0d" + "0102" + compact(2n) + "00010100");
    const beneficiaryAccount = take32();
    expect("0f" + "0101" + USDT_FROM_XODE + "00" + "04" + "0000" + FUNGIBLE);
    const minXonPlanck = num();
    expect("01" + "2c");
    const topic = take32();
    if (2 * at !== hex.length) return null;
    if (usdtAmount === 0n || minXonPlanck === 0n || paraId > 0xffffffffn) return null;
    return { usdtAmount, minXonPlanck, beneficiaryAccount, topic, paraId: Number(paraId) };
  } catch {
    return null;
  }
}

// --- The precompile call --------------------------------------------------------------------

export interface XcmWeight {
  refTime: bigint;
  proofSize: bigint;
}

export function encodeExecuteCall(message: string, weight: XcmWeight): string {
  return xcmPrecompile.encodeFunctionData("execute", [message, [weight.refTime, weight.proofSize]]);
}

/// The XCM message and weight of a precompile `execute` call, or null if `data` is anything else.
export function decodeExecuteCall(data: string): { message: string; weight: XcmWeight } | null {
  try {
    const parsed = xcmPrecompile.parseTransaction({ data });
    if (!parsed || parsed.name !== "execute") return null;
    // Re-encoding must give back the same bytes: no trailing data, no non-canonical ABI.
    const [message, weight] = parsed.args as unknown as [string, [bigint, bigint]];
    const result = { message, weight: { refTime: weight[0], proofSize: weight[1] } };
    if (encodeExecuteCall(result.message, result.weight).toLowerCase() !== data.toLowerCase()) return null;
    return result;
  } catch {
    return null;
  }
}

// --- Accounts -----------------------------------------------------------------------------------
// pallet-revive's AccountId32Mapper, as on Xode and AssetHub: an EVM address `a` belongs to the
// AccountId32 that was mapped to it (`map_account`), else to its fallback account `a ++ 0xEE * 12`.

const EE12 = "ee".repeat(12);

/// The fallback AccountId32 of an EVM address - what an EVM wallet's address is on-chain, and
/// what pallet-revive pays an address that isn't mapped to a Substrate account.
export function fallbackAccount(address: string): string {
  return "0x" + strip(ethers.getAddress(address)) + EE12;
}

/// pallet-revive's `to_address`: the EVM address an AccountId32 shows up as.
export function accountToAddress(account: string): string {
  const hex = bytes32(account, "account");
  if (hex.endsWith(EE12)) return ethers.getAddress("0x" + hex.slice(0, 40));
  return ethers.getAddress(ethers.dataSlice(ethers.keccak256("0x" + hex), 12));
}

/// The minimum XON (18-decimal units, as the API takes it) in planck, rounded up so the buyer never
/// accepts less than they asked for.
export function minXonToPlanck(minXonOut: bigint): bigint {
  return (minXonOut + PLANCK_TO_WEI - 1n) / PLANCK_TO_WEI;
}

/// A random message id.
export function newTopic(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}
