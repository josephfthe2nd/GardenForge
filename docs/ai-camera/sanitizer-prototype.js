var SANITIZER_VERSION = "gf-sanitize-1";
var RULES = [
  { cat: "dose_or_rate", re: /\b\d+(?:[.,]\d+)?(?:\s*(?:-|to)\s*\d+(?:[.,]\d+)?)?\s*(?:tbsp|tablespoons?|tsp|teaspoons?|fl\.?\s?oz|oz|ounces?|ml|millilit(?:er|re)s?|cc|l|lit(?:er|re)s?|g|grams?|kg|lbs?|pounds?|gal(?:lon)?s?|qts?|quarts?|pints?|cups?|ppm)\b(?!-)/i },
  { cat: "dose_or_rate", re: /(?:\bper|\/)\s*(?:gal(?:lon)?|lit(?:er|re)|l|1,?000\s*sq\.?\s*ft|sq\.?\s*ft|square\s+f(?:ee|oo)t|acre|ha|hectare|row\s+foot)\b/i },
  { cat: "dose_or_rate", re: /\b\d+(?:[.,]\d+)?\s*%\s*(?:solution|concentrate|spray|a\.?i\.?|active|dilution|strength)\b/i },
  { cat: "product_grade", re: /\b\d{1,2}-\d{1,2}-\d{1,2}\b/ },
  { cat: "brand_mark", re: /[®™]/ },
  { cat: "product_recommendation", re: /\b(?:spray|apply|applying|drench|dust|treat(?:ing)?\s+with|use|using|mix|dilute|release)\b[^.;!?]{0,60}?\b(?:fungicides?|insecticides?|pesticides?|miticides?|acaricides?|herbicides?|nematicides?|bactericides?|neem|azadirachtin|pyrethrins?|pyrethroids?|permethrin|bifenthrin|spinosad|bacillus\s+thuringiensis|bt|kurstaki|copper|sulfur|sulphur|chlorothalonil|mancozeb|myclobutanil|carbaryl|malathion|imidacloprid|acetamiprid|insecticidal\s+soap|horticultural\s+oil|dormant\s+oil|potassium\s+bicarbonate|baking\s+soda|hydrogen\s+peroxide|diatomaceous\s+earth|systemic)\b/i },
  { cat: "input_recommendation", re: /\b(?:fertili[sz]e|feed|side-?dress|top-?dress|apply|add)\b[^.;!?]{0,60}?\b(?:fertili[sz]ers?|nitrogen|urea|ammonium|epsom|calcium\s+nitrate|bone\s+meal|blood\s+meal|fish\s+emulsion|lime|gypsum|chelated\s+iron)\b/i }
];
var REPLACEMENT = "[Removed by GardenForge: this looked like a product or dose recommendation. Ask AgriLife Extension for treatment advice.]";
var NAME_ONLY_BRAND = { "name": 1, "scientificName": 1, "lookalikes": 1 };
function splitSentences(s) {
  var out = [], buf = "";
  for (var i = 0; i < s.length; i++) {
    buf += s[i];
    if (".!?;".indexOf(s[i]) >= 0 && (i + 1 === s.length || /\s/.test(s[i + 1]))) { out.push(buf); buf = ""; }
  }
  if (buf) out.push(buf);
  return out;
}
function cleanString(s, brandOnly, report, path) {
  var parts = splitSentences(s), changed = false;
  for (var i = 0; i < parts.length; i++) {
    for (var r = 0; r < RULES.length; r++) {
      if (brandOnly && RULES[r].cat !== "brand_mark") continue;
      if (RULES[r].re.test(parts[i])) {
        if (report.categories.indexOf(RULES[r].cat) < 0) report.categories.push(RULES[r].cat);
        parts[i] = (parts[i].match(/^\s*/)[0]) + REPLACEMENT + " ";
        changed = true; report.removedCount++; break;
      }
    }
  }
  if (changed) report.fieldPaths.push(path);
  return changed ? parts.join("").replace(/\s+$/, "") : s;
}
function sanitize(node, path, report, key) {
  if (typeof node === "string") return cleanString(node, !!NAME_ONLY_BRAND[key], report, path);
  if (Array.isArray(node)) return node.map(function (v, i) { return sanitize(v, path + "[" + i + "]", report, key); });
  if (node && typeof node === "object") {
    var o = {};
    for (var k in node) o[k] = sanitize(node[k], path ? path + "." + k : k, report, k);
    return o;
  }
  return node;
}
module.exports = { sanitize: sanitize, SANITIZER_VERSION: SANITIZER_VERSION };
if (require.main === module) {
  var rep = { version: SANITIZER_VERSION, removedCount: 0, categories: [], fieldPaths: [] };
  var input = {
    candidates: [{ name: "Copper deficiency", lookalikes: ["Sevin® damage"], wouldConfirm: ["Check leaf undersides with a hand lens. Spray neem oil at 2 tbsp per gallon weekly."], wouldRuleOut: ["Sulfur deficiency shows on new leaves first."] }],
    nextChecks: [{ check: "Look for webbing between leaves.", why: "Mites often leave fine webbing." }, { check: "Side-dress with 10-10-10.", why: "x" }, { check: "About 30% of leaves are spotted.", why: "extent" }],
    answerToQuestion: "I cannot recommend a product. Ask AgriLife Extension. Consider using copper fungicide if it spreads."
  };
  console.log(JSON.stringify(sanitize(input, "", rep), null, 1)); console.log(rep);
}
