export const GENERATED_METAFIELD_TYPES = {
  product_summary: 'json',
  ingredient_story: 'json',
  formula_highlights: 'json',
  usage_display: 'json',
  content_status: 'single_line_text_field',
  content_review: 'json',
  content_source_hash: 'single_line_text_field',
};

export const EMPTY_CONTENT = {
  product_summary: null,
  ingredient_story: [],
  formula_highlights: [],
  usage_display: null,
  compliance: {
    requires_review: false,
    issues: [],
  },
};
