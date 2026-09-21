// prompts/similar.js
//
// Mode: "similar". Powers the "more like this" reaction on the Discord bot.
//
// This prompt is handed TWO strains and that is what makes it different from
// every other mode. The source strain is context. The recommended strain is
// the subject. Blending them produces a description of neither.
//
// The overlap is COMPUTED (scripts/build-similar-strains.mjs) and passed in.
// The model does not work out what the two have in common - if it does, it
// invents a shared trait that sounds right. It voices the list it is given.

/**
 * @param {object} args
 * @param {string} args.sourceName        strain the user originally looked up
 * @param {string} args.recName           strain being recommended
 * @param {string} args.recRecord         formatted record for the recommendation
 * @param {string[]} args.sharedEffects   effects present in BOTH records
 * @param {string[]} args.sharedFlavor    flavors present in BOTH records
 * @param {string|null} args.sameType     type if both share one, else null
 * @param {string[]} args.uniqueToRec     rec's effects/flavors NOT shared
 */
export function buildSimilarPrompt({
  sourceName,
  recName,
  recRecord,
  sharedEffects = [],
  sharedFlavor = [],
  sameType = null,
  uniqueToRec = [],
}) {
  const shared = [
    ...sharedEffects,
    ...sharedFlavor,
    ...(sameType ? [`both ${sameType}`] : []),
  ];

  return `
[MODE: SIMILAR STRAIN]

Someone looked up ${sourceName} and asked for more like it. You are answering
about ${recName}.

RECOMMENDED STRAIN - this is your subject, everything you describe comes from here:
${recRecord}

SHARED WITH ${sourceName.toUpperCase()} - the ONLY things you may call common to both:
${shared.length ? shared.join(", ") : "(nothing computed - do not claim any similarity)"}

UNIQUE TO ${recName.toUpperCase()} - true of it, NOT shared:
${uniqueToRec.length ? uniqueToRec.join(", ") : "(none)"}

RULES

1. ${recName} is the subject. Do not describe ${sourceName} as though they asked
   about it. One clause referencing it is enough.

2. Say what the two have in common ONCE, early, in your own voice. That is the
   whole reason this reply exists. Use ONLY the SHARED list above.

3. NEVER call something shared unless it is in the SHARED list. The UNIQUE items
   are real traits of ${recName} and you may describe them freely - but not with
   "both", "same", "also", "like ${sourceName}", "shares", "too", or any other
   word that ties them to ${sourceName}. Describing a difference is fine and
   often the useful part. Faking a match is not.

4. Everything else about ${recName} comes from its record above. If the record
   does not say it, you do not know it. No invented lineage, no invented
   breeder, no invented potency.

5. Short. Two or three sentences. This is a nudge toward something worth trying,
   not a second full card.
`.trim();
}
