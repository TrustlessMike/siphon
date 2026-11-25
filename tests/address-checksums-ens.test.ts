import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import { evmAdapter } from '../src/adapters/evm.js';
import {
  detectAddressFamily,
  getAdapterForChain,
  getFamilyForChain,
  isEvmChain,
} from '../src/adapters/registry.js';
import {
  convertBits,
  crc16Xmodem,
  decodeBase58Check,
  decodeBech32Strict,
  detectAddress,
  encodeBase58Check,
  encodeBech32Strict,
  ENS_ADDR_SELECTOR,
  ENS_REGISTRY_ADDRESS,
  ENS_RESOLVER_SELECTOR,
  ensNamehash,
  EnsResolutionError,
  getCosmosChainForAddress,
  isValidEnsName,
  normalizeMoveAddress,
  resolveEnsName,
  resolveEnsNameOrThrow,
  toChecksumEvmAddress,
  validateBitcoinAddress,
  validateCosmosAddress,
  validateCosmosAddressList,
  validateEvmAddressOrEns,
  validateEvmHexAddress,
  validateMoveAddress,
  validateTonAddress,
  validateTronAddress,
  ZERO_EVM_ADDRESS,
} from '../src/scanner/address.js';
import { EVM_CHAINS } from '../src/scanner/chains.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import { createSiphonServer } from '../src/server/app.js';

function makeTonFriendlyAddress(params: {
  tag: number;
  workchain: number;
  hashByte: number;
  urlSafe?: boolean;
  corruptCrc?: boolean;
}): string {
  const buf = Buffer.alloc(36);
  buf[0] = params.tag & 0xff;
  buf.writeInt8(params.workchain, 1);
  buf.fill(params.hashByte & 0xff, 2, 34);
  const crc = crc16Xmodem(buf.subarray(0, 34)) ^ (params.corruptCrc ? 0x0001 : 0);
  buf[34] = (crc >>> 8) & 0xff;
  buf[35] = crc & 0xff;
  const std = buf.toString('base64');
  return params.urlSafe === false ? std : std.replace(/\+/g, '-').replace(/\//g, '_');
}

function makeCosmosAddress(hrp: string, fillByte = 0x42, encoding: 'bech32' | 'bech32m' = 'bech32'): string {
  const payload = Array.from({ length: 20 }, (_, i) => (fillByte + i) & 0xff);
  const words = convertBits(payload, 8, 5, true);
  assert.ok(words, 'convertBits(8->5) must succeed');
  return encodeBech32Strict(hrp, words, encoding);
}

function makeBtcWitnessAddress(
  hrp: string,
  version: number,
  programLen: number,
  encoding: 'bech32' | 'bech32m'
): string {
  const prog = Array.from({ length: programLen }, (_, i) => (i * 7 + 1) & 0xff);
  const words = convertBits(prog, 8, 5, true);
  assert.ok(words);
  return encodeBech32Strict(hrp, [version, ...words], encoding);
}

function encodeAbiAddress(address: string): string {
  return '0x' + address.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

test('HIGH-03 Bitcoin: Base58Check double-SHA256 + BIP-173/350 Bech32/Bech32m & Solana collision defense', () => {
  // Valid mainnet addresses across all 5 Bitcoin address types
  const p2pkh = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const p2sh = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
  const p2wpkh = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const p2wsh = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
  const p2tr = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

  assert.equal(validateBitcoinAddress(p2pkh).valid, true);
  assert.equal(validateBitcoinAddress(p2pkh).meta?.type, 'p2pkh');
  assert.equal(detectAddressFamily(p2pkh), 'btc');

  assert.equal(validateBitcoinAddress(p2sh).valid, true);
  assert.equal(validateBitcoinAddress(p2sh).meta?.type, 'p2sh');
  assert.equal(detectAddressFamily(p2sh), 'btc');

  assert.equal(validateBitcoinAddress(p2wpkh).valid, true);
  assert.equal(validateBitcoinAddress(p2wpkh).meta?.type, 'p2wpkh');
  assert.equal(detectAddressFamily(p2wpkh), 'btc');
  // Single-case ALL-UPPERCASE Bech32/Bech32m is valid per BIP-173/350
  assert.equal(detectAddressFamily(p2wpkh.toUpperCase()), 'btc');
  assert.equal(detectAddressFamily(p2tr.toUpperCase()), 'btc');

  assert.equal(validateBitcoinAddress(p2wsh).valid, true);
  assert.equal(validateBitcoinAddress(p2wsh).meta?.type, 'p2wsh');
  assert.equal(detectAddressFamily(p2wsh), 'btc');

  assert.equal(validateBitcoinAddress(p2tr).valid, true);
  assert.equal(validateBitcoinAddress(p2tr).meta?.type, 'p2tr');
  assert.equal(detectAddressFamily(p2tr), 'btc');

  // Adversarial 1: Solana System Program pubkey MUST NOT collide with BTC Base58
  const solanaSystemProgram = '11111111111111111111111111111111';
  assert.equal(validateBitcoinAddress(solanaSystemProgram).valid, false);
  assert.equal(detectAddressFamily(solanaSystemProgram), null);
  assert.equal(detectAddressFamily(solanaSystemProgram, 'btc'), null);

  // Adversarial 2: Corrupted Base58Check checksums (single character flip)
  assert.equal(validateBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').valid, false);
  assert.equal(detectAddressFamily('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'), null);
  assert.equal(validateBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz').valid, false);
  assert.equal(detectAddressFamily('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz'), null);

  // Adversarial 3: Testnet version bytes (0x6f / 0xc4) and testnet Bech32 (tb1...)
  const testnetP2pkh = encodeBase58Check(Buffer.concat([Buffer.from([0x6f]), Buffer.alloc(20, 0x11)]));
  const testnetP2sh = encodeBase58Check(Buffer.concat([Buffer.from([0xc4]), Buffer.alloc(20, 0x22)]));
  const testnetBech32 = makeBtcWitnessAddress('tb', 0, 20, 'bech32');
  assert.equal(validateBitcoinAddress(testnetP2pkh).valid, false);
  assert.equal(validateBitcoinAddress(testnetP2sh).valid, false);
  assert.equal(validateBitcoinAddress(testnetBech32).valid, false);
  assert.equal(detectAddressFamily(testnetBech32), null);

  // Adversarial 4: Mixed-case Bech32/Bech32m (BIP-173/350 violation)
  assert.equal(validateBitcoinAddress('Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').valid, false);
  assert.equal(detectAddressFamily('Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), null);
  assert.equal(validateBitcoinAddress('bc1P5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr').valid, false);

  // Adversarial 5: Invalid Bech32/Bech32m checksums
  assert.equal(validateBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').valid, false);
  assert.equal(validateBitcoinAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcq').valid, false);

  // Adversarial 6: BIP-350 encoding mismatch (v0 with Bech32m; v1 with Bech32)
  const v0Bech32m = makeBtcWitnessAddress('bc', 0, 20, 'bech32m');
  const v1Bech32 = makeBtcWitnessAddress('bc', 1, 32, 'bech32');
  assert.equal(validateBitcoinAddress(v0Bech32m).valid, false);
  assert.equal(validateBitcoinAddress(v1Bech32).valid, false);
  assert.equal(detectAddressFamily(v0Bech32m), null);
  assert.equal(detectAddressFamily(v1Bech32), null);

  // Adversarial 7: Invalid witness version (bc1z... = v2) even with valid Bech32m checksum
  const v2Bech32m = makeBtcWitnessAddress('bc', 2, 32, 'bech32m');
  assert.ok(v2Bech32m.startsWith('bc1z'));
  assert.equal(validateBitcoinAddress(v2Bech32m).valid, false);
  assert.equal(detectAddressFamily(v2Bech32m), null);

  // Adversarial 8: Invalid witness lengths (v0 != 20/32 bytes; v1 != 32 bytes)
  const v0Len21 = makeBtcWitnessAddress('bc', 0, 21, 'bech32');
  const v1Len20 = makeBtcWitnessAddress('bc', 1, 20, 'bech32m');
  assert.equal(validateBitcoinAddress(v0Len21).valid, false);
  assert.equal(validateBitcoinAddress(v1Len20).valid, false);
  assert.equal(detectAddressFamily(v0Len21), null);
  assert.equal(detectAddressFamily(v1Len20), null);
});

test('HIGH-03 Tron: Base58Check 0x41 + 42-char 41... hex & Solana Token Program collision defense', () => {
  const tronMainnet = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
  const tronUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  const res = validateTronAddress(tronMainnet);
  assert.equal(res.valid, true);
  assert.equal(res.meta?.format, 'base58check');
  assert.equal(res.meta?.base58, tronMainnet);
  assert.ok(res.meta?.hex.startsWith('41') && res.meta.hex.length === 42);
  assert.equal(detectAddressFamily(tronMainnet), 'tron');
  assert.equal(detectAddressFamily(tronUsdt), 'tron');

  // 42-char 41... hex format round-trips to exact canonical Base58Check T... address
  const tronHex = res.meta!.hex;
  const hexRes = validateTronAddress(tronHex);
  assert.equal(hexRes.valid, true);
  assert.equal(hexRes.meta?.format, 'hex');
  assert.equal(hexRes.normalized, tronMainnet);
  assert.equal(detectAddressFamily(tronHex), 'tron');
  assert.equal(detectAddressFamily(tronHex.toUpperCase()), 'tron');

  // Adversarial 1: Solana SPL Token Program prefix/full pubkey MUST NOT match Tron!
  const solanaToken34 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9S';
  const solanaTokenFull = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  assert.equal(validateTronAddress(solanaToken34).valid, false);
  assert.equal(detectAddressFamily(solanaToken34), null);
  assert.equal(detectAddressFamily(solanaToken34, 'tron'), null);
  assert.equal(detectAddressFamily(solanaTokenFull), null);

  // Adversarial 2: Invalid T111... and checksum-corrupted T... addresses
  assert.equal(validateTronAddress('T111111111111111111111111111111111').valid, false);
  assert.equal(detectAddressFamily('T111111111111111111111111111111111'), null);
  assert.equal(validateTronAddress('TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqel').valid, false);
  assert.equal(detectAddressFamily('TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqel'), null);

  // Adversarial 3: Valid Base58Check with wrong version byte (0x42 instead of 0x41)
  const wrongVersion = encodeBase58Check(Buffer.concat([Buffer.from([0x42]), Buffer.alloc(20, 0xab)]));
  assert.equal(decodeBase58Check(wrongVersion)?.version, 0x42);
  assert.equal(validateTronAddress(wrongVersion).valid, false);
  assert.equal(detectAddressFamily(wrongVersion), null);

  // Adversarial 4: Invalid 42-char hex with wrong prefix (42... instead of 41...)
  assert.equal(validateTronAddress('42' + 'a'.repeat(40)).valid, false);
  assert.equal(detectAddressFamily('42' + 'a'.repeat(40)), null);
});

test('HIGH-03 Cosmos: strict Bech32 checksum, exact 6-HRP mapping, and NO silent cosmoshub fallback', () => {
  const hrpMap: Array<[string, string]> = [
    ['cosmos', 'cosmoshub'],
    ['osmo', 'osmosis'],
    ['noble', 'noble'],
    ['celestia', 'celestia'],
    ['inj', 'injective'],
    ['neutron', 'neutron'],
  ];

  const validList: string[] = [];
  for (const [hrp, expectedChain] of hrpMap) {
    const addr = makeCosmosAddress(hrp, 0x2a, 'bech32');
    validList.push(addr);
    const v = validateCosmosAddress(addr);
    assert.equal(v.valid, true, `Expected ${addr} to be valid`);
    assert.equal(v.meta?.chain, expectedChain);
    assert.equal(getCosmosChainForAddress(addr), expectedChain);
    assert.equal(detectAddressFamily(addr), 'cosmos');
    // Single-case uppercase Bech32 is valid
    assert.equal(detectAddressFamily(addr.toUpperCase()), 'cosmos');
    assert.equal(getCosmosChainForAddress(addr.toUpperCase()), expectedChain);
  }

  // Multi-chain comma-separated valid Cosmos addresses
  const multi = validList.slice(0, 3).join(',');
  const multiRes = validateCosmosAddressList(multi);
  assert.equal(multiRes.valid, true);
  assert.deepEqual(multiRes.meta?.chains, ['cosmoshub', 'osmosis', 'noble']);
  assert.equal(detectAddressFamily(multi), 'cosmos');

  // Adversarial 1: Invalid Bech32 charset characters (1, b, i, o) e.g. cosmos1bio1...
  const invalidCharset = 'cosmos1bio1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
  assert.equal(validateCosmosAddress(invalidCharset).valid, false);
  assert.equal(getCosmosChainForAddress(invalidCharset), null);
  assert.equal(detectAddressFamily(invalidCharset), null);

  // Adversarial 2: Invalid checksum (swapped HRP without recomputing checksum)
  assert.equal(validateCosmosAddress('osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh').valid, false);
  assert.equal(detectAddressFamily('osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), null);
  assert.equal(validateCosmosAddress('cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0ea').valid, false);
  assert.equal(detectAddressFamily('cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0ea'), null);

  // Adversarial 3: Mixed-case Bech32
  assert.equal(validateCosmosAddress('Cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh').valid, false);
  assert.equal(detectAddressFamily('Cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), null);

  // Adversarial 4: Bech32m-encoded Cosmos address (must be Bech32!)
  const cosmosBech32m = makeCosmosAddress('cosmos', 0x2a, 'bech32m');
  assert.equal(decodeBech32Strict(cosmosBech32m)?.encoding, 'bech32m');
  assert.equal(validateCosmosAddress(cosmosBech32m).valid, false);
  assert.equal(detectAddressFamily(cosmosBech32m), null);

  // Adversarial 5: Unsupported HRPs with VALID Bech32 checksum MUST NEVER fall back to cosmoshub
  for (const unsupportedHrp of ['juno', 'stars', 'terra', 'atom', 'evmos']) {
    const validForeign = makeCosmosAddress(unsupportedHrp, 0x11, 'bech32');
    assert.ok(decodeBech32Strict(validForeign), `${unsupportedHrp} fixture must have valid Bech32`);
    assert.equal(validateCosmosAddress(validForeign).valid, false);
    assert.equal(getCosmosChainForAddress(validForeign), null);
    assert.equal(detectAddressFamily(validForeign), null);
  }

  // Adversarial 6: Multi-chain list containing even one corrupted address fails closed
  assert.equal(detectAddressFamily(`${validList[0]},osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh`), null);
});

test('HIGH-03 TON: CRC16-XMODEM friendly Base64/Base64URL, mainnet-only (rejects kQ/0Q), and raw -1:/0: (rejects -0:)', () => {
  // Known mainnet addresses + constructed mainnet bounceable/non-bounceable/masterchain addresses
  const knownEq = 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2';
  const uqUrl = makeTonFriendlyAddress({ tag: 0x51, workchain: 0, hashByte: 0x3c, urlSafe: true });
  const efUrl = makeTonFriendlyAddress({ tag: 0x11, workchain: -1, hashByte: 0x7f, urlSafe: true });
  const ufStd = makeTonFriendlyAddress({ tag: 0x51, workchain: -1, hashByte: 0xfb, urlSafe: false });

  assert.ok(uqUrl.startsWith('UQ'));
  assert.ok(efUrl.startsWith('Ef'));
  assert.ok(ufStd.startsWith('Uf'));

  assert.equal(validateTonAddress(knownEq).valid, true);
  assert.equal(detectAddressFamily(knownEq), 'ton');
  assert.equal(validateTonAddress(uqUrl).valid, true);
  assert.equal(detectAddressFamily(uqUrl), 'ton');
  assert.equal(validateTonAddress(efUrl).valid, true);
  assert.equal(validateTonAddress(efUrl).meta?.workchain, -1);
  assert.equal(detectAddressFamily(efUrl), 'ton');
  assert.equal(validateTonAddress(ufStd).valid, true);
  assert.equal(detectAddressFamily(ufStd), 'ton');

  // Raw masterchain (-1:) and basechain (0:)
  const rawMaster = `-1:${'a'.repeat(64)}`;
  const rawBase = `0:${'b'.repeat(64)}`;
  assert.equal(validateTonAddress(rawMaster).valid, true);
  assert.equal(validateTonAddress(rawMaster).meta?.workchain, -1);
  assert.equal(detectAddressFamily(rawMaster), 'ton');
  assert.equal(validateTonAddress(rawBase).valid, true);
  assert.equal(validateTonAddress(rawBase).meta?.workchain, 0);
  assert.equal(detectAddressFamily(rawBase), 'ton');

  // Adversarial 1: Raw -0:<64hex> and unsupported workchains (1:, -2:) rejected
  assert.equal(validateTonAddress(`-0:${'a'.repeat(64)}`).valid, false);
  assert.equal(detectAddressFamily(`-0:${'a'.repeat(64)}`), null);
  assert.equal(validateTonAddress(`1:${'a'.repeat(64)}`).valid, false);
  assert.equal(detectAddressFamily(`1:${'a'.repeat(64)}`), null);

  // Adversarial 2: Testnet 0x80 addresses (kQ = 0x91, 0Q = 0xd1, kf, 0f) WITH VALID CRC16 rejected on mainnet!
  const testnetKq = makeTonFriendlyAddress({ tag: 0x91, workchain: 0, hashByte: 0x12 });
  const testnet0Q = makeTonFriendlyAddress({ tag: 0xd1, workchain: 0, hashByte: 0x12 });
  const testnetKf = makeTonFriendlyAddress({ tag: 0x91, workchain: -1, hashByte: 0x12 });
  const testnet0f = makeTonFriendlyAddress({ tag: 0xd1, workchain: -1, hashByte: 0x12 });
  assert.ok(testnetKq.startsWith('kQ'));
  assert.ok(testnet0Q.startsWith('0Q'));
  assert.equal(validateTonAddress(testnetKq).valid, false);
  assert.equal(detectAddressFamily(testnetKq), null);
  assert.equal(validateTonAddress(testnet0Q).valid, false);
  assert.equal(detectAddressFamily(testnet0Q), null);
  assert.equal(validateTonAddress(testnetKf).valid, false);
  assert.equal(validateTonAddress(testnet0f).valid, false);

  // Adversarial 3: Corrupted CRC16-XMODEM checksum on mainnet EQ/UQ address
  const badCrc = makeTonFriendlyAddress({ tag: 0x11, workchain: 0, hashByte: 0x3c, corruptCrc: true });
  assert.ok(badCrc.startsWith('EQ'));
  assert.equal(validateTonAddress(badCrc).valid, false);
  assert.equal(detectAddressFamily(badCrc), null);
  assert.equal(detectAddressFamily('EQdtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'), null);
});

test('HIGH-03 EVM EIP-55 checksum, Move short/64-hex disambiguation, and Registry Safety', () => {
  const vitalik = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  const vitalikLower = vitalik.toLowerCase();
  const vitalikUpper = '0x' + vitalik.slice(2).toUpperCase();
  const vitalikBadChecksum = '0xd8da6BF26964aF9D7eEd9e03E53415D37aA96045'; // 'A' flipped to 'a' at index 5

  // Valid EIP-55, all-lowercase, and all-uppercase
  assert.equal(toChecksumEvmAddress(vitalikLower), vitalik);
  assert.equal(validateEvmHexAddress(vitalik).valid, true);
  assert.equal(validateEvmHexAddress(vitalikLower).valid, true);
  assert.equal(validateEvmHexAddress(vitalikUpper).valid, true);
  assert.equal(detectAddressFamily(vitalik), 'evm');
  assert.equal(detectAddressFamily(vitalikLower), 'evm');
  assert.equal(detectAddressFamily(vitalikUpper), 'evm');
  assert.equal(evmAdapter.matchesAddress(vitalik), true);

  // Invalid mixed-case EIP-55 MUST fail everywhere and NEVER fall through to Sui/Aptos
  assert.equal(validateEvmHexAddress(vitalikBadChecksum).valid, false);
  assert.equal(validateEvmAddressOrEns(vitalikBadChecksum).valid, false);
  assert.equal(evmAdapter.matchesAddress(vitalikBadChecksum), false);
  assert.equal(detectAddressFamily(vitalikBadChecksum), null);
  assert.equal(detectAddressFamily(vitalikBadChecksum, 'evm'), null);
  assert.equal(detectAddressFamily(vitalikBadChecksum, 'sui'), null);
  assert.equal(detectAddressFamily(vitalikBadChecksum, 'aptos'), null);

  // Move short addresses (0x1..0x+64 hex) left-pad to 64 hex
  assert.equal(
    normalizeMoveAddress('0x1'),
    '0x0000000000000000000000000000000000000000000000000000000000000001'
  );
  assert.equal(
    normalizeMoveAddress('0x2'),
    '0x0000000000000000000000000000000000000000000000000000000000000002'
  );
  assert.equal(validateMoveAddress('0x1').valid, true);
  assert.equal(validateMoveAddress('0x1').meta?.isShort, true);
  assert.equal(validateMoveAddress('0x' + 'f'.repeat(65)).valid, false);

  // Short Move addresses work when preferredFamily is sui or aptos
  assert.equal(detectAddressFamily('0x1', 'aptos'), 'aptos');
  assert.equal(detectAddressFamily('0x2', 'sui'), 'sui');
  assert.equal(detectAddressFamily('0xdeadbeef', 'sui'), 'sui');
  assert.equal(
    detectAddress('0x1', 'aptos')?.normalized,
    '0x0000000000000000000000000000000000000000000000000000000000000001'
  );

  // Short Move addresses DO NOT collide with 40-hex EVM addresses when preferredFamily is set
  assert.equal(detectAddressFamily(vitalik, 'sui'), 'evm');
  assert.equal(detectAddressFamily(vitalik, 'aptos'), 'evm');
  assert.equal(detectAddressFamily(vitalikLower, 'sui'), 'evm');
  assert.equal(detectAddressFamily(vitalikLower, 'aptos'), 'evm');

  // Unhinted truncated hex (not 40 or 64 hex) is rejected
  assert.equal(detectAddressFamily('0x1'), null);
  assert.equal(detectAddressFamily('0x123456'), null);
  assert.equal(detectAddressFamily('0x' + 'a'.repeat(39)), null);

  // Unhinted 64-hex Move address is clearly flagged as ambiguous between Sui and Aptos
  const fullMove = '0x0000000000000000000000000000000000000000000000000000000000000006';
  const unhinted = detectAddress(fullMove);
  assert.ok(unhinted);
  assert.equal(unhinted.family, 'sui');
  assert.equal(unhinted.ambiguous, true);
  assert.deepEqual(unhinted.possibleFamilies, ['sui', 'aptos']);
  assert.ok(unhinted.disambiguationHint && unhinted.disambiguationHint.includes('preferredFamily'));

  const hintedAptos = detectAddress(fullMove, 'aptos');
  assert.ok(hintedAptos);
  assert.equal(hintedAptos.family, 'aptos');
  assert.equal(hintedAptos.ambiguous, false);
  assert.deepEqual(hintedAptos.possibleFamilies, ['aptos']);

  // Registry Safety: getFamilyForChain MUST NOT silently fall back to 'evm'
  for (const evmChain of Object.keys(EVM_CHAINS)) {
    assert.equal(isEvmChain(evmChain), true);
    assert.equal(getFamilyForChain(evmChain), 'evm');
  }
  assert.equal(getFamilyForChain('cosmoshub'), 'cosmos');
  assert.equal(getFamilyForChain('osmosis'), 'cosmos');
  assert.equal(getFamilyForChain('sui'), 'sui');
  assert.equal(getFamilyForChain('aptos'), 'aptos');
  assert.equal(getFamilyForChain('ton'), 'ton');
  assert.equal(getFamilyForChain('tron'), 'tron');
  assert.equal(getFamilyForChain('btc'), 'btc');

  for (const unknown of ['solana', 'fantom', 'unknown_chain', '', '__proto__', 'constructor', 'toString']) {
    assert.equal(isEvmChain(unknown), false);
    assert.equal(getFamilyForChain(unknown), null, `Unknown chain "${unknown}" must return null, not evm`);
    assert.throws(() => getAdapterForChain(unknown), /Unsupported chain/);
  }
});

test('HIGH-03 ENS: EIP-137 namehash vectors, multi-label subdomain detection, and deterministic resolution', async () => {
  // Exact EIP-137 test vectors
  assert.equal(
    ensNamehash(''),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  );
  assert.equal(
    ensNamehash('eth'),
    '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae'
  );
  assert.equal(
    ensNamehash('foo.eth'),
    '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f'
  );
  assert.equal(
    ensNamehash('vitalik.eth'),
    '0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835'
  );
  assert.equal(ensNamehash('VITALIK.ETH'), ensNamehash('vitalik.eth'));

  // Verify multi-label subdomain namehash matches EIP-137 recursive definition
  const parentBytes = Buffer.from(ensNamehash('name.eth').slice(2), 'hex');
  const subLabelHash = keccak_256(Buffer.from('sub', 'utf8'));
  const expectedSubNode = '0x' + Buffer.from(keccak_256(Buffer.concat([parentBytes, subLabelHash]))).toString('hex');
  assert.equal(ensNamehash('sub.name.eth'), expectedSubNode);

  // ENS syntax & multi-label subdomain detection
  assert.equal(isValidEnsName('vitalik.eth'), true);
  assert.equal(isValidEnsName('VITALIK.ETH'), true);
  assert.equal(isValidEnsName('sub.name.eth'), true);
  assert.equal(isValidEnsName('a.b.c.eth'), true);
  assert.equal(isValidEnsName('my-wallet.sub-1.eth'), true);
  assert.equal(detectAddressFamily('vitalik.eth'), 'evm');
  assert.equal(detectAddressFamily('sub.name.eth'), 'evm');
  assert.equal(evmAdapter.matchesAddress('sub.name.eth'), true);
  assert.equal(detectAddress('sub.name.eth')?.isEns, true);

  // Invalid ENS names rejected
  for (const bad of ['.eth', '-bad.eth', 'bad-.eth', 'a..b.eth', 'vitalik.com', 'vitalik.eth.', 'foo bar.eth']) {
    assert.equal(isValidEnsName(bad), false, `Expected "${bad}" to be rejected`);
    assert.equal(detectAddressFamily(bad), null);
    assert.equal(evmAdapter.matchesAddress(bad), false);
  }

  // Deterministic ENS Registry + Public Resolver resolution (vitalik.eth & sub.name.eth)
  const publicResolver = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
  const vitalikAddr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  const subAddr = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
  const vitalikNode = ensNamehash('vitalik.eth').slice(2);
  const subNode = ensNamehash('sub.name.eth').slice(2);

  const calls: Array<{ to: string; data: string }> = [];
  const mockRpcCall = async (
    _rpcUrls: string[],
    method: string,
    params: unknown[]
  ): Promise<{ result?: string; error?: { message?: string; code?: number } }> => {
    assert.equal(method, 'eth_call');
    const tx = params[0] as { to: string; data: string };
    calls.push(tx);

    if (tx.to.toLowerCase() === ENS_REGISTRY_ADDRESS.toLowerCase()) {
      assert.ok(tx.data.startsWith(`0x${ENS_RESOLVER_SELECTOR}`));
      const node = tx.data.slice(10);
      if (node === vitalikNode || node === subNode) {
        return { result: encodeAbiAddress(publicResolver) };
      }
      return { result: encodeAbiAddress(ZERO_EVM_ADDRESS) };
    }

    if (tx.to.toLowerCase() === publicResolver.toLowerCase()) {
      assert.ok(tx.data.startsWith(`0x${ENS_ADDR_SELECTOR}`));
      const node = tx.data.slice(10);
      if (node === vitalikNode) return { result: encodeAbiAddress(vitalikAddr) };
      if (node === subNode) return { result: encodeAbiAddress(subAddr) };
      return { result: encodeAbiAddress(ZERO_EVM_ADDRESS) };
    }

    return { error: { code: 3, message: 'execution reverted' } };
  };

  assert.equal(await resolveEnsName('vitalik.eth', { rpcCall: mockRpcCall }), vitalikAddr);
  assert.equal(await resolveEnsName('sub.name.eth', { rpcCall: mockRpcCall }), subAddr);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].to, ENS_REGISTRY_ADDRESS);
  assert.equal(calls[0].data, `0x${ENS_RESOLVER_SELECTOR}${vitalikNode}`);
  assert.equal(calls[1].to.toLowerCase(), publicResolver.toLowerCase());
  assert.equal(calls[1].data, `0x${ENS_ADDR_SELECTOR}${vitalikNode}`);

  // Unresolved ENS (zero resolver) -> null / EnsResolutionError('UNRESOLVED')
  assert.equal(await resolveEnsName('unregistered-siphon.eth', { rpcCall: mockRpcCall }), null);
  await assert.rejects(
    () => resolveEnsNameOrThrow('unregistered-siphon.eth', { rpcCall: mockRpcCall }),
    (err: unknown) => err instanceof EnsResolutionError && err.code === 'UNRESOLVED'
  );

  // Resolver returns zero address -> null / EnsResolutionError('UNRESOLVED')
  const zeroAddrRpc = async (_urls: string[], _m: string, params: unknown[]) => {
    const tx = params[0] as { to: string };
    if (tx.to.toLowerCase() === ENS_REGISTRY_ADDRESS.toLowerCase()) {
      return { result: encodeAbiAddress(publicResolver) };
    }
    return { result: encodeAbiAddress(ZERO_EVM_ADDRESS) };
  };
  assert.equal(await resolveEnsName('zero-record.eth', { rpcCall: zeroAddrRpc }), null);
  await assert.rejects(
    () => resolveEnsNameOrThrow('zero-record.eth', { rpcCall: zeroAddrRpc }),
    (err: unknown) => err instanceof EnsResolutionError && err.code === 'UNRESOLVED'
  );

  // RPC outage -> EnsResolutionError('RPC_ERROR')
  const failingRpc = async () => {
    throw new Error('upstream timeout');
  };
  await assert.rejects(
    () => resolveEnsNameOrThrow('vitalik.eth', { rpcCall: failingRpc }),
    (err: unknown) => err instanceof EnsResolutionError && err.code === 'RPC_ERROR'
  );
});

test('HIGH-03 HTTP /api/scan, /api/plan & evmAdapter.scanWallet(): ENS resolution + adversarial rejection', async () => {
  const publicResolver = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
  const vitalikAddr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  const subAddr = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
  const vitalikNode = ensNamehash('vitalik.eth').slice(2);
  const subNode = ensNamehash('sub.name.eth').slice(2);

  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Allow local test server requests through untouched
    if (urlStr.startsWith(base)) {
      return originalFetch(input, init);
    }

    // Mock Ethereum JSON-RPC calls (ENS Registry/Resolver + Multicall3 scan)
    if (init?.method === 'POST' && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body);
        const handleSingle = (rpc: { id: number; method: string; params?: unknown[] }) => {
          if (rpc.method === 'eth_call') {
            const callObj = (rpc.params?.[0] ?? {}) as { to?: string; data?: string };
            const to = (callObj.to ?? '').toLowerCase();
            const data = (callObj.data ?? '').toLowerCase();
            if (to === ENS_REGISTRY_ADDRESS.toLowerCase() && data.startsWith(`0x${ENS_RESOLVER_SELECTOR}`)) {
              const node = data.slice(10);
              if (node === vitalikNode || node === subNode) {
                return { jsonrpc: '2.0', id: rpc.id, result: encodeAbiAddress(publicResolver) };
              }
              return { jsonrpc: '2.0', id: rpc.id, result: encodeAbiAddress(ZERO_EVM_ADDRESS) };
            }
            if (to === publicResolver.toLowerCase() && data.startsWith(`0x${ENS_ADDR_SELECTOR}`)) {
              const node = data.slice(10);
              if (node === vitalikNode) {
                return { jsonrpc: '2.0', id: rpc.id, result: encodeAbiAddress(vitalikAddr) };
              }
              if (node === subNode) {
                return { jsonrpc: '2.0', id: rpc.id, result: encodeAbiAddress(subAddr) };
              }
              return { jsonrpc: '2.0', id: rpc.id, result: encodeAbiAddress(ZERO_EVM_ADDRESS) };
            }
            return { jsonrpc: '2.0', id: rpc.id, result: '0x' };
          }
          if (rpc.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: rpc.id, result: '0x1400000' };
          if (rpc.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: rpc.id, result: '0x3b9aca00' };
          if (rpc.method === 'eth_getBalance') return { jsonrpc: '2.0', id: rpc.id, result: '0x0' };
          return { jsonrpc: '2.0', id: rpc.id, result: '0x0' };
        };

        const payload = Array.isArray(parsed) ? parsed.map(handleSingle) : handleSingle(parsed);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        // fall through
      }
    }

    // Mock external price / discovery endpoints quickly so scan completes deterministically
    return new Response(JSON.stringify({ coins: {}, pairs: [], tokens: [], result: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    // 1. evmAdapter.scanWallet('vitalik.eth') resolves ENS onchain and scans resolved EVM address
    const adapterReport = await evmAdapter.scanWallet('vitalik.eth');
    assert.equal(adapterReport.family, 'evm');
    assert.equal(adapterReport.walletAddress, vitalikAddr);
    assert.equal(adapterReport.walletLabel, 'vitalik.eth');

    // 2. evmAdapter.scanWallet('unregistered-test.eth') throws EnsResolutionError('UNRESOLVED')
    await assert.rejects(
      () => evmAdapter.scanWallet('unregistered-test.eth'),
      (err: unknown) => err instanceof EnsResolutionError && err.code === 'UNRESOLVED'
    );

    // 3. POST /api/scan with multi-label ENS subdomain sub.name.eth resolves and returns 200
    const subScanRes = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'sub.name.eth' }),
    });
    assert.equal(subScanRes.status, 200);
    const subScan = (await subScanRes.json()) as { walletAddress: string; walletLabel?: string; family: string };
    assert.equal(subScan.family, 'evm');
    assert.equal(subScan.walletAddress, subAddr);
    assert.equal(subScan.walletLabel, 'sub.name.eth');

    // 4. POST /api/scan with unresolved .eth returns clear 400 error
    const unresolvedRes = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'does-not-exist-siphon-xyz.eth' }),
    });
    assert.equal(unresolvedRes.status, 400);
    const unresolvedBody = (await unresolvedRes.json()) as { error: string };
    assert.match(unresolvedBody.error, /does not resolve/i);

    // 5. POST /api/scan rejects adversarial collisions & bad checksums with 400
    const badInputs = [
      '11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9S',
      '0xd8da6BF26964aF9D7eEd9e03E53415D37aA96045',
      'cosmos1bio1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      'osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
      'Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      `-0:${'a'.repeat(64)}`,
      makeTonFriendlyAddress({ tag: 0x91, workchain: 0, hashByte: 0x12 }),
    ];
    for (const badAddress of badInputs) {
      const r = await fetch(`${base}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: badAddress }),
      });
      assert.equal(r.status, 400, `Expected 400 for adversarial address "${badAddress}", got ${r.status}`);
    }

    // 6. POST /api/plan resolves inline scan with ENS walletAddress (and 400s if unresolved)
    const preset = await scanPresetWallet('veteran_defi');
    const ensPlanRes = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scan: { ...preset, walletAddress: 'vitalik.eth', walletLabel: '' },
        solanaDestination: '',
      }),
    });
    assert.equal(ensPlanRes.status, 200);
    const ensPlan = (await ensPlanRes.json()) as { sourceWallet?: string };
    assert.equal(ensPlan.sourceWallet, vitalikAddr);

    const badEnsPlanRes = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scan: { ...preset, walletAddress: 'does-not-exist-siphon-xyz.eth' },
        solanaDestination: '',
      }),
    });
    assert.equal(badEnsPlanRes.status, 400);
    const badEnsPlanBody = (await badEnsPlanRes.json()) as { error: string };
    assert.match(badEnsPlanBody.error, /does not resolve/i);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
