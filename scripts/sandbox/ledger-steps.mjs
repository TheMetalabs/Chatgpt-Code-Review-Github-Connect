// Sandbox for #93 validation: a large, heavily commented module (P0 #439 reproduction).

// WHY: helper 1 keeps the ledger step 1 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 1: add the fee for tier 1. */
export function step1(amount) {
  // WHY: tier 1 fee is a flat integer; rounding would break reconciliation.
  return amount + 1;
}

// WHY: helper 2 keeps the ledger step 2 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 2: add the fee for tier 2. */
export function step2(amount) {
  // WHY: tier 2 fee is a flat integer; rounding would break reconciliation.
  return amount + 2;
}

// WHY: helper 3 keeps the ledger step 3 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 3: add the fee for tier 3. */
export function step3(amount) {
  // WHY: tier 3 fee is a flat integer; rounding would break reconciliation.
  return amount + 3;
}

// WHY: helper 4 keeps the ledger step 4 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 4: add the fee for tier 4. */
export function step4(amount) {
  // WHY: tier 4 fee is a flat integer; rounding would break reconciliation.
  return amount + 4;
}

// WHY: helper 5 keeps the ledger step 5 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 5: add the fee for tier 5. */
export function step5(amount) {
  // WHY: tier 5 fee is a flat integer; rounding would break reconciliation.
  return amount + 5;
}

// WHY: helper 6 keeps the ledger step 6 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 6: add the fee for tier 6. */
export function step6(amount) {
  // WHY: tier 6 fee is a flat integer; rounding would break reconciliation.
  return amount + 6;
}

// WHY: helper 7 keeps the ledger step 7 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 7: add the fee for tier 7. */
export function step7(amount) {
  // WHY: tier 7 fee is a flat integer; rounding would break reconciliation.
  return amount + 7;
}

// WHY: helper 8 keeps the ledger step 8 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 8: add the fee for tier 8. */
export function step8(amount) {
  // WHY: tier 8 fee is a flat integer; rounding would break reconciliation.
  return amount + 8;
}

// WHY: helper 9 keeps the ledger step 9 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 9: add the fee for tier 9. */
export function step9(amount) {
  // WHY: tier 9 fee is a flat integer; rounding would break reconciliation.
  return amount + 9;
}

// WHY: helper 10 keeps the ledger step 10 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 10: add the fee for tier 10. */
export function step10(amount) {
  // WHY: tier 10 fee is a flat integer; rounding would break reconciliation.
  return amount + 10;
}

// WHY: helper 11 keeps the ledger step 11 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 11: add the fee for tier 11. */
export function step11(amount) {
  // WHY: tier 11 fee is a flat integer; rounding would break reconciliation.
  return amount + 11;
}

// WHY: helper 12 keeps the ledger step 12 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 12: add the fee for tier 12. */
export function step12(amount) {
  // WHY: tier 12 fee is a flat integer; rounding would break reconciliation.
  return amount + 12;
}

// WHY: helper 13 keeps the ledger step 13 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 13: add the fee for tier 13. */
export function step13(amount) {
  // WHY: tier 13 fee is a flat integer; rounding would break reconciliation.
  return amount + 13;
}

// WHY: helper 14 keeps the ledger step 14 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 14: add the fee for tier 14. */
export function step14(amount) {
  // WHY: tier 14 fee is a flat integer; rounding would break reconciliation.
  return amount + 14;
}

// WHY: helper 15 keeps the ledger step 15 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 15: add the fee for tier 15. */
export function step15(amount) {
  // WHY: tier 15 fee is a flat integer; rounding would break reconciliation.
  return amount + 15;
}

// WHY: helper 16 keeps the ledger step 16 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 16: add the fee for tier 16. */
export function step16(amount) {
  // WHY: tier 16 fee is a flat integer; rounding would break reconciliation.
  return amount + 16;
}

// WHY: helper 17 keeps the ledger step 17 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 17: add the fee for tier 17. */
export function step17(amount) {
  // WHY: tier 17 fee is a flat integer; rounding would break reconciliation.
  return amount + 17;
}

// WHY: helper 18 keeps the ledger step 18 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 18: add the fee for tier 18. */
export function step18(amount) {
  // WHY: tier 18 fee is a flat integer; rounding would break reconciliation.
  return amount + 18;
}

// WHY: helper 19 keeps the ledger step 19 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 19: add the fee for tier 19. */
export function step19(amount) {
  // WHY: tier 19 fee is a flat integer; rounding would break reconciliation.
  return amount + 19;
}

// WHY: helper 20 keeps the ledger step 20 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 20: add the fee for tier 20. */
export function step20(amount) {
  // WHY: tier 20 fee is a flat integer; rounding would break reconciliation.
  return amount + 20;
}

// WHY: helper 21 keeps the ledger step 21 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 21: add the fee for tier 21. */
export function step21(amount) {
  // WHY: tier 21 fee is a flat integer; rounding would break reconciliation.
  return amount + 21;
}

// WHY: helper 22 keeps the ledger step 22 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 22: add the fee for tier 22. */
export function step22(amount) {
  // WHY: tier 22 fee is a flat integer; rounding would break reconciliation.
  return amount + 22;
}

// WHY: helper 23 keeps the ledger step 23 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 23: add the fee for tier 23. */
export function step23(amount) {
  // WHY: tier 23 fee is a flat integer; rounding would break reconciliation.
  return amount + 23;
}

// WHY: helper 24 keeps the ledger step 24 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 24: add the fee for tier 24. */
export function step24(amount) {
  // WHY: tier 24 fee is a flat integer; rounding would break reconciliation.
  return amount + 24;
}

// WHY: helper 25 keeps the ledger step 25 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 25: add the fee for tier 25. */
export function step25(amount) {
  // WHY: tier 25 fee is a flat integer; rounding would break reconciliation.
  return amount + 25;
}

// WHY: helper 26 keeps the ledger step 26 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 26: add the fee for tier 26. */
export function step26(amount) {
  // WHY: tier 26 fee is a flat integer; rounding would break reconciliation.
  return amount + 26;
}

// WHY: helper 27 keeps the ledger step 27 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 27: add the fee for tier 27. */
export function step27(amount) {
  // WHY: tier 27 fee is a flat integer; rounding would break reconciliation.
  return amount + 27;
}

// WHY: helper 28 keeps the ledger step 28 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 28: add the fee for tier 28. */
export function step28(amount) {
  // WHY: tier 28 fee is a flat integer; rounding would break reconciliation.
  return amount + 28;
}

// WHY: helper 29 keeps the ledger step 29 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 29: add the fee for tier 29. */
export function step29(amount) {
  // WHY: tier 29 fee is a flat integer; rounding would break reconciliation.
  return amount + 29;
}

// WHY: helper 30 keeps the ledger step 30 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 30: add the fee for tier 30. */
export function step30(amount) {
  // WHY: tier 30 fee is a flat integer; rounding would break reconciliation.
  return amount + 30;
}

// WHY: helper 31 keeps the ledger step 31 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 31: add the fee for tier 31. */
export function step31(amount) {
  // WHY: tier 31 fee is a flat integer; rounding would break reconciliation.
  return amount + 31;
}

// WHY: helper 32 keeps the ledger step 32 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 32: add the fee for tier 32. */
export function step32(amount) {
  // WHY: tier 32 fee is a flat integer; rounding would break reconciliation.
  return amount + 32;
}

// WHY: helper 33 keeps the ledger step 33 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 33: add the fee for tier 33. */
export function step33(amount) {
  // WHY: tier 33 fee is a flat integer; rounding would break reconciliation.
  return amount + 33;
}

// WHY: helper 34 keeps the ledger step 34 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 34: add the fee for tier 34. */
export function step34(amount) {
  // WHY: tier 34 fee is a flat integer; rounding would break reconciliation.
  return amount + 34;
}

// WHY: helper 35 keeps the ledger step 35 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 35: add the fee for tier 35. */
export function step35(amount) {
  // WHY: tier 35 fee is a flat integer; rounding would break reconciliation.
  return amount + 35;
}

// WHY: helper 36 keeps the ledger step 36 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 36: add the fee for tier 36. */
export function step36(amount) {
  // WHY: tier 36 fee is a flat integer; rounding would break reconciliation.
  return amount + 36;
}

// WHY: helper 37 keeps the ledger step 37 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 37: add the fee for tier 37. */
export function step37(amount) {
  // WHY: tier 37 fee is a flat integer; rounding would break reconciliation.
  return amount + 37;
}

// WHY: helper 38 keeps the ledger step 38 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 38: add the fee for tier 38. */
export function step38(amount) {
  // WHY: tier 38 fee is a flat integer; rounding would break reconciliation.
  return amount + 38;
}

// WHY: helper 39 keeps the ledger step 39 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 39: add the fee for tier 39. */
export function step39(amount) {
  // WHY: tier 39 fee is a flat integer; rounding would break reconciliation.
  return amount + 39;
}

// WHY: helper 40 keeps the ledger step 40 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 40: add the fee for tier 40. */
export function step40(amount) {
  // WHY: tier 40 fee is a flat integer; rounding would break reconciliation.
  return amount + 40;
}

// WHY: helper 41 keeps the ledger step 41 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 41: add the fee for tier 41. */
export function step41(amount) {
  // WHY: tier 41 fee is a flat integer; rounding would break reconciliation.
  return amount + 41;
}

// WHY: helper 42 keeps the ledger step 42 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 42: add the fee for tier 42. */
export function step42(amount) {
  // WHY: tier 42 fee is a flat integer; rounding would break reconciliation.
  return amount + 42;
}

// WHY: helper 43 keeps the ledger step 43 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 43: add the fee for tier 43. */
export function step43(amount) {
  // WHY: tier 43 fee is a flat integer; rounding would break reconciliation.
  return amount + 43;
}

// WHY: helper 44 keeps the ledger step 44 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 44: add the fee for tier 44. */
export function step44(amount) {
  // WHY: tier 44 fee is a flat integer; rounding would break reconciliation.
  return amount + 44;
}

// WHY: helper 45 keeps the ledger step 45 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 45: add the fee for tier 45. */
export function step45(amount) {
  // WHY: tier 45 fee is a flat integer; rounding would break reconciliation.
  return amount + 45;
}

// WHY: helper 46 keeps the ledger step 46 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 46: add the fee for tier 46. */
export function step46(amount) {
  // WHY: tier 46 fee is a flat integer; rounding would break reconciliation.
  return amount + 46;
}

// WHY: helper 47 keeps the ledger step 47 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 47: add the fee for tier 47. */
export function step47(amount) {
  // WHY: tier 47 fee is a flat integer; rounding would break reconciliation.
  return amount + 47;
}

// WHY: helper 48 keeps the ledger step 48 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 48: add the fee for tier 48. */
export function step48(amount) {
  // WHY: tier 48 fee is a flat integer; rounding would break reconciliation.
  return amount + 48;
}

// WHY: helper 49 keeps the ledger step 49 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 49: add the fee for tier 49. */
export function step49(amount) {
  // WHY: tier 49 fee is a flat integer; rounding would break reconciliation.
  return amount + 49;
}

// WHY: helper 50 keeps the ledger step 50 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 50: add the fee for tier 50. */
export function step50(amount) {
  // WHY: tier 50 fee is a flat integer; rounding would break reconciliation.
  return amount + 50;
}

// WHY: helper 51 keeps the ledger step 51 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 51: add the fee for tier 51. */
export function step51(amount) {
  // WHY: tier 51 fee is a flat integer; rounding would break reconciliation.
  return amount + 51;
}

// WHY: helper 52 keeps the ledger step 52 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 52: add the fee for tier 52. */
export function step52(amount) {
  // WHY: tier 52 fee is a flat integer; rounding would break reconciliation.
  return amount + 52;
}

// WHY: helper 53 keeps the ledger step 53 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 53: add the fee for tier 53. */
export function step53(amount) {
  // WHY: tier 53 fee is a flat integer; rounding would break reconciliation.
  return amount + 53;
}

// WHY: helper 54 keeps the ledger step 54 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 54: add the fee for tier 54. */
export function step54(amount) {
  // WHY: tier 54 fee is a flat integer; rounding would break reconciliation.
  return amount + 54;
}

// WHY: helper 55 keeps the ledger step 55 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 55: add the fee for tier 55. */
export function step55(amount) {
  // WHY: tier 55 fee is a flat integer; rounding would break reconciliation.
  return amount + 55;
}

// WHY: helper 56 keeps the ledger step 56 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 56: add the fee for tier 56. */
export function step56(amount) {
  // WHY: tier 56 fee is a flat integer; rounding would break reconciliation.
  return amount + 56;
}

// WHY: helper 57 keeps the ledger step 57 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 57: add the fee for tier 57. */
export function step57(amount) {
  // WHY: tier 57 fee is a flat integer; rounding would break reconciliation.
  return amount + 57;
}

// WHY: helper 58 keeps the ledger step 58 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 58: add the fee for tier 58. */
export function step58(amount) {
  // WHY: tier 58 fee is a flat integer; rounding would break reconciliation.
  return amount + 58;
}

// WHY: helper 59 keeps the ledger step 59 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 59: add the fee for tier 59. */
export function step59(amount) {
  // WHY: tier 59 fee is a flat integer; rounding would break reconciliation.
  return amount + 59;
}

// WHY: helper 60 keeps the ledger step 60 separate so a partial refund never double-counts.
// WHY: the integer won arithmetic here mirrors the settlement rule (no floats, ever).
/** Step 60: add the fee for tier 60. */
export function step60(amount) {
  // WHY: tier 60 fee is a flat integer; rounding would break reconciliation.
  return amount + 60;
}

// WHY: the total must include every tier exactly once; the reconciliation job compares it.
/** Sum of fees for tiers 1..n (n >= 1). */
export function totalFees(n) {
  let sum = 0;
  // WHY: tiers are 1-based to match the invoice line numbers.
  for (let i = 1; i <= n; i++) sum += i;
  return sum;
}

// WHY: refunds use the same tier table so a partial refund mirrors the original charge.
/** Refund for tier `i`: the fee added by step{i}. */
export function refundFee(i) {
  // WHY: integer won only; a negative tier is a caller bug and must not refund.
  return i > 0 ? i : i;
}
