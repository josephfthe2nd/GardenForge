// Reviewed species facts, separate from model estimates. Never infer a local zone from a photo.
// Brief factual summaries of NC State Extension Plant Toolbox pages checked 2026-11-17.
const profiles = {
  'solanum lycopersicum': {slug:'solanum-lycopersicum',zone:'Frost-sensitive seasonal crop',pH:'5.8–6.8',sunlight:'Full sun',soil:'Moist, loamy soil with good drainage.',watering:'Keep moisture consistent; avoid repeated wet-to-dry swings.',feeding:'Avoid excess nitrogen, which can favor leaves over fruit.'},
  'ocimum basilicum': {slug:'ocimum-basilicum',zone:'10a–10b; also grown as a seasonal annual',sunlight:'Full sun; partial shade tolerated',soil:'Moist soil with good drainage.',seasonal:'Protect from frost. Pinch growing tips and flower buds for bushier growth.'},
  'capsicum annuum': {slug:'capsicum-annuum',zone:'Frost-tender; grown as a seasonal crop',sunlight:'Full sun',soil:'Rich, moist soil with good drainage.',watering:'Maintain even moisture rather than alternating drought and saturation.'},
  'quercus virginiana': {slug:'quercus-virginiana',zone:'8a–10b',pH:'Acidic to neutral',sunlight:'Full sun to partial shade',soil:'Adaptable to clay, loam, or sand; prefers good drainage.'},
  'aloe vera': {slug:'aloe-vera',zone:'10a–12b',pH:'Tolerates acidic, neutral, and alkaline soil',sunlight:'Full sun to partial shade',soil:'A very freely draining succulent mix; use a pot with drainage holes.',watering:'Let the soil dry completely between waterings.',seasonal:'Reduce watering in winter.'}
};
const aliases = {'lycopersicon esculentum':'solanum lycopersicum','lycopersicon lycopersicum':'solanum lycopersicum','aloe barbadensis':'aloe vera'};
export const CARE_TEXT_FIELDS = ['watering','wateringCheck','wateringMethod','sunlight','soil','feeding','seasonal'];
export function cleanModelCare(care) {
  if (!care || typeof care !== 'object' || Array.isArray(care)) return null;
  const output = {};
  for (const key of CARE_TEXT_FIELDS) {
    if (typeof care[key] !== 'string' || !care[key].trim() || care[key].length > 600) return null;
    output[key] = care[key];
  }
  if(typeof care.wateringSignal==='string'&&care.wateringSignal.trim()&&care.wateringSignal.length<=600)output.wateringSignal=care.wateringSignal;
  return output;
}
export function enrichCare(analysis, input) {
  // Exact scientific-name matching only: no guessing from common names or a supplied planting label.
  const name = analysis.scientificName.trim().toLowerCase().replace(/\s+/g,' ');
  const profile = !analysis.uncertain && analysis.confidence >= .75 ? profiles[aliases[name] || name] : null;
  const defaults = {
    watering:'Check root-zone moisture before deciding to water.',
    wateringCheck:'Check moisture regularly; confirm the plant and growing conditions before setting a watering interval.',
    wateringMethod:'Check drainage and soil moisture first. A photo does not measure root-zone moisture.',
    sunlight:'Confirm the identification before changing its light exposure.',
    soil:'Confirm species preferences and check drainage. Soil type cannot be measured from this scan.',
    feeding:'Use a soil or media test and product directions before choosing fertilizer.',
    seasonal:'Adjust care to the plant, season, and actual weather.'
  };
  const care = {...defaults,...(cleanModelCare(analysis.care)||{}),zone:'Not yet verified for this identification',pH:'Not verified; test your soil or potting mix',reference:null};
  if (profile) {
    const {slug,...facts}=profile;
    Object.assign(care,facts);
    care.reference={title:'NC State Extension · '+analysis.scientificName,url:'https://plants.ces.ncsu.edu/plants/'+slug+'/',checkedAt:'2026-11-17',fields:Object.keys(facts)};
  }
  care.context={location:'Brownsville, Texas',gardenZone:input.gardenZone||'',growingLocation:input.growingLocation||'unspecified'};
  care.identificationUncertain=analysis.uncertain||analysis.confidence<.75;
  return care;
}
