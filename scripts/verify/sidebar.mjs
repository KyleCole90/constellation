export const expandCourse = async (t, code) => {
  const expand = `[data-testid="sidebar"] [aria-label="Expand ${code}"]`;
  if (await t.has(expand)) await t.click(expand);
};
