/** A plan's reps as shown: "10-12" → "10–12", "Max" → "макс." (the seed data is written for code, not for reading). */
export const repsLabel = (reps: string) => reps.replace(/(\d)\s*-\s*(\d)/g, '$1–$2').replace(/\bmax\b/i, 'макс.')
