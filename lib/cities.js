"use strict";

const { boroughs } = require("./nyc-boroughs.json");
const NYC = "New-York--NY";
const BAY_AREA = ["San-Francisco--CA", "Oakland--CA", "Daly-City--CA"];
const DEFAULT_CITIES = [...BAY_AREA, NYC];
const clean = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function cityAliases(city) {
  const aliases = [clean(city), clean(city.split("--")[0])];
  if (city === "San-Francisco--CA") aliases.push("sf");
  if (city === NYC) aliases.push("nyc", "new york city", "new york city ny");
  return aliases;
}

function matchCities(location, cities) {
  const text = clean(location);
  if (!text || /^(anywhere|any|all|all cities)$/.test(text)) return cities.slice();
  if (/^(bay area|san francisco bay area)$/.test(text)) return cities.filter(city => BAY_AREA.includes(city));
  return cities.filter(city => cityAliases(city).includes(text));
}

function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Uses the public approximate map pin, not a claim about the exact address. */
function nycBorough(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Reject distant points before walking the borough rings.
  if (lat < 40.4 || lat > 41 || lng < -74.3 || lng > -73.6) return null;
  for (const borough of boroughs) {
    for (const [outer, ...holes] of borough.polygons) {
      if (insideRing(lng, lat, outer) && !holes.some(ring => insideRing(lng, lat, ring))) return borough.name;
    }
  }
  return null;
}

function isWithinCity(city, listing) {
  return city !== NYC || nycBorough(listing.lat, listing.lng) !== null;
}

module.exports = { NYC, DEFAULT_CITIES, cityAliases, matchCities, nycBorough, isWithinCity };
