export const riskConfig = {
  risk: {
    hardDrawdownHaltPct: 0.25,
    maxPositionValueUsd: 98.00,            // was 80 — allow up to $98 (leaves ~$2 reserve)
    maxRiskPerTradePct: 0.02,
    profitLockAtrMult: 0.5,
    profitLockMinPct: 0.0015,
    consecutiveLossThreshold: 2,
    lossCooldownMs: 60 * 60_000,
    maxSingleTradePct: 1.00,
    extremeVolatilityAtrPct: 20.0,
    megaPumpSkipVelocityPct: 15.0,
    tpTier1Pct: 0.05,
    tpTier1Portion: 1.0,
    tpTier2Pct: 0.10,
    tpTier2Portion: 0.30,
    tpTrailPortion: 0.40,
    trailActivationPct: 0.05,
    trailStopAtrMult: 2.5,
    fixedSlPct: 0,
    atrSlMult: 3.0,                        // was 2.0 — wider SL to avoid fake-out hits (28/52 trades were SL, many at -0.8%)
    slippageBufferPct: 0.03,
    fixedTpPct: 0,
    tpTier1AtrMult: 4.0,                    // was 2.5 — wider TP to let winners run (avg win was only +1.5%)
    tpTier2AtrMult: 6.0,                    // was 4.5 — proportional increase
    breakevenAtrMult: 2.5,                   // was 1.8 — raised to match wider SL (lock profit later)
    meanReversionExitEnabled: false,
    trailAfterTier1: true,
    tpTimeDecayPct: 0.10,
    tpTimeDecayWindowMs: 4 * 60 * 60_000,
    maxHoldingHours: 24,
  },

  futures: {
    enabled: true,
    leverage: 1,
    longScoreThreshold: 0.17,          // was 0.05 — longs had 21% WR; only strong longs (score>0.25) are profitable
    shortScoreThreshold: -0.05,
    minAbsScoreForEntry: 0.20,
    minConfidenceForEntry: 0.30,       // was 0.10 — conf <0.30 had 33% WR and lost money
    counterTrendStrongScore: 0.22,
    counterTrendMinConfidence: 0.20,
    overboughtLongRsi: 70,
    minConfidenceLongOverbought: 0.12,
    hardRsiMaxForLong: 75,           // hard gate: never open LONG above this RSI
    hardRsiMinForShort: 38,          // hard gate: never open SHORT below this RSI (was 25 — oversold shorts lose per journal data)
    minBbWidthForEntry: 1.2,         // was 2.0 — relaxat, filtrul din engine (longBbWidthEntryMin) e mai precis
    maxPricePosForLong: 70,          // hard gate: no LONG when price_position > 70% (was 80 — T0043 loss at pricePos 93% confirmed top-buys lose)
    htfOverrideMaxOpposingScore: 0.10,
    requireHtfBearishForShort: true,
    directionFlipCooldownMs: 30 * 60_000,
    minHoldBeforeFlipMs: 15 * 60_000,
    adxMinForFlip: 25,
    minVolumeForEntry: 0.06,          // was 0.25 — APR/USDT are structural volume 0.08-0.25x, 0.25 blocheaza mereu
    positionSizePct: 0.95,             // was 0.50 — user wants ~100% capital allocation
    maxPositionSizePct: 1.00,

    // ── Breakout Override: relaxed gates when vol state is ARMED/TRIGGERED ──
    breakoutRsiMaxForLong:92 ,         // RSI > 70 = strength during breakout, not overbought
    breakoutMaxPricePosForLong: 95,    // breakout IS at the top of the range
    breakoutMinBbWidth: 0.5,           // squeeze precedes breakout — allow tight BB
    breakoutAtrPctMinHard: 0.10,       // volatility rises AFTER entry during breakout

    // ── Momentum Breakout Detection: detect pumps even without BB squeeze ──
    momentumBreakoutMinVelocity: 1.8,  // price velocity % to consider momentum breakout (lowered from 2.5: steady grinds with vel 2.0%+ missed)
    momentumBreakoutMinAdx: 20,        // ADX must confirm trending

    // ── Early Long Momentum: catch upward moves before full breakout ──────
    // Fires when velocity 1.5%+ + ADX confirms trend, but before RSI/pricePos hit ceiling.
    // Relaxes score gate (0.04) and BB gate (0.5%) for LONG only — does NOT affect SHORT logic.
    earlyLongMomentumMinVelocity: 1.5,   // vel% threshold to activate (below full breakout 2.5%)
    earlyLongMomentumMinAbsScore: 0.04,  // relaxed min score (normal = 0.12)

    // ── Exhaustion Override: SHORT exhaustion cancels weak LONG ──────────
    // When shortSignal.stage==='exhaustion' fires with high confidence AND the LONG
    // score is below counterTrendStrongScore, the exhaustion wins and we try SHORT.
    // HTF gate still applies — if HTF is bullish, result is HOLD (not SHORT).
    exhaustionOverrideMinConf: 0.55,     // min shortSignal confidence to trigger override (lowered: leading signals are reliable)

    // ── Market Regime: Choppy/Ranging detection ──────────────────────────
    // Block new entries when ADX is weak AND BBWidth is tight = pure sideways market.
    // Both conditions must be true — ADX low alone could be a pre-breakout squeeze.
    // Gate is skipped automatically when isBreakoutMode is active.
    choppyAdxMax: 18,          // ADX below this = weak/no trend
    choppyBbWidthMax: 2.5,     // BBWidth below this (%) = tight range

    // ── Squeeze Short Gate: block shorts in BB squeeze with low ATR ──────
    // Low ATR + squeeze = range too tight, MACD crossovers are noise on bottom.
    squeezeShortMaxAtrPct: 0.85,   // ATR% below this + squeeze = skip short

    // ── Strong Trend Counter-Short Gate: block counter-trend shorts when ADX very high ──
    // ADX > 40 = extremely strong trend, don't short against it regardless of score.
    counterTrendShortMaxAdx: 40,   // ADX above this in trending_up = never short
  },
};
