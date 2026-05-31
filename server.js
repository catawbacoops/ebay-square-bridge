const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const xml2js = require("xml2js");
const { create } = require("xmlbuilder2");

const app = express();

// Load weight lookup table (SKU -> weight in lbs)
let WEIGHT_LOOKUP = {};
try {
  WEIGHT_LOOKUP = JSON.parse(fs.readFileSync(path.join(__dirname, "weight_lookup.json"), "utf8"));
  console.log(`Loaded ${Object.keys(WEIGHT_LOOKUP).length} SKU weights`);
} catch(e) {
  console.warn("weight_lookup.json not found");
}

// ── Ended Listings Store ─────────────────────────────────────────────────────
// Persists listings ended due to sellable=N so they can be auto/manually relisted.
// Schema: { [sku]: { sku, itemId, endedAt, title, ebayPrice, categoryId, conditionId,
//                    brand, itemType, weightLbs, imageUrl, description, quantity } }
const ENDED_LISTINGS_PATH = path.join(__dirname, "ended_listings.json");

function loadEndedListings() {
  try {
    return JSON.parse(fs.readFileSync(ENDED_LISTINGS_PATH, "utf8"));
  } catch(e) {
    return {};
  }
}

function saveEndedListings(data) {
  fs.writeFileSync(ENDED_LISTINGS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function addEndedListing(entry) {
  const store = loadEndedListings();
  store[entry.sku] = { ...entry, endedAt: new Date().toISOString() };
  saveEndedListings(store);
}

function removeEndedListing(sku) {
  const store = loadEndedListings();
  delete store[sku];
  saveEndedListings(store);
}

// ── eBay Store Category Mapping ───────────────────────────────────────────────
// Maps eBay marketplace category IDs to exact-mirror Store category names.
// Store categories are created on demand via SetStoreCategories if they don't exist.
const EBAY_TO_STORE_CATEGORY = {
  // All listings use eBay's Food & Beverages parent category (14308)
  // Store categories are manually maintained in eBay Seller Hub
  // Map: eBay marketplace category ID → Store category name
  // The Store category name must exactly match what you created in eBay Store
  "14308": "Food & Beverages",  // default — updated after Store category fetch
};

// In-memory cache: Store category name -> Store category ID
// Populated on first use by fetching the store, then kept in sync.
let storeCategoryCache = null; // null = not yet loaded

// ── eBay Business Policy cache ────────────────────────────────────────────────
// Accounts enrolled in Business Policies must use profile IDs instead of
// legacy ShippingDetails / ReturnPolicy / PaymentMethods fields.
let sellerProfilesCache = null;

async function getSellerProfiles() {
  if (sellerProfilesCache) return sellerProfilesCache;

  // Business Policy IDs must be set as environment variables.
  // Find them in eBay Seller Hub → Shipping / Returns / Payments policy pages.
  // The ID appears in the URL when you edit a policy: e.g. policyId=XXXXXXXXXX
  const shippingId = process.env.EBAY_SHIPPING_POLICY_ID || null;
  const returnId   = process.env.EBAY_RETURN_POLICY_ID   || null;
  const paymentId  = process.env.EBAY_PAYMENT_POLICY_ID  || null;

  if (shippingId && returnId && paymentId) {
    sellerProfilesCache = { shippingId, returnId, paymentId };
    console.log(`✓ Business policies loaded — shipping:${shippingId} return:${returnId} payment:${paymentId}`);
  } else {
    console.warn(
      "Business Policy IDs not configured — falling back to legacy fields.\n" +
      "Fix: set EBAY_SHIPPING_POLICY_ID, EBAY_RETURN_POLICY_ID, EBAY_PAYMENT_POLICY_ID in Render env vars."
    );
    sellerProfilesCache = null;
  }
  return sellerProfilesCache;
}

// Build the policy XML block — uses Business Policy IDs if available,
// falls back to legacy fields for accounts not enrolled in Business Policies.
async function buildPolicyXml(itemNode, { weightPounds, weightOunces, pkgDepth, pkgWidth, pkgHeight }) {
  const profiles = await getSellerProfiles();

  if (profiles) {
    // Business Policies path
    itemNode = itemNode
      .ele("SellerProfiles")
        .ele("SellerShippingProfile")
          .ele("ShippingProfileID").txt(profiles.shippingId).up()
        .up()
        .ele("SellerReturnProfile")
          .ele("ReturnProfileID").txt(profiles.returnId).up()
        .up()
        .ele("SellerPaymentProfile")
          .ele("PaymentProfileID").txt(profiles.paymentId).up()
        .up()
      .up()
      .ele("ShippingPackageDetails")
        .ele("MeasurementUnit").txt("English").up()
        .ele("WeightMajor").txt(String(weightPounds)).up()
        .ele("WeightMinor").txt(String(weightOunces)).up()
        .ele("ShippingPackage").txt("ExtraLargePack").up()
        .ele("ShippingIrregular").txt("true").up()
      .up();
  } else {
    // Legacy fields fallback
    itemNode = itemNode
      .ele("ShippingDetails")
        .ele("ShippingType").txt("Calculated").up()
        .ele("ShippingServiceOptions")
          .ele("ShippingServicePriority").txt("1").up()
          .ele("ShippingService").txt("UPSGround").up()
        .up()
        .ele("ShipToLocations").txt("US").up()
        .ele("CalculatedShippingRate")
          .ele("PackagingHandlingCosts").txt("0.00").up()
          .ele("OriginatingPostalCode").txt(process.env.SHIP_FROM_ZIP || "17067").up()
        .up()
      .up()
      .ele("ShippingPackageDetails")
        .ele("MeasurementUnit").txt("English").up()
        .ele("WeightMajor").txt(String(weightPounds)).up()
        .ele("WeightMinor").txt(String(weightOunces)).up()
        .ele("ShippingPackage").txt("ExtraLargePack").up()
        .ele("ShippingIrregular").txt("true").up()
      .up()
      .ele("ReturnPolicy")
        .ele("ReturnsAcceptedOption").txt("ReturnsAccepted").up()
        .ele("RefundOption").txt("MoneyBack").up()
        .ele("ReturnsWithinOption").txt("Days_30").up()
        .ele("ShippingCostPaidByOption").txt("Buyer").up()
      .up()
      .ele("PaymentMethods").txt("PayPal").up()
      .ele("PayPalEmailAddress").txt(PAYPAL_EMAIL).up();
  }

  return itemNode
    .ele("Location").txt(process.env.SHIP_FROM_CITY || "Myerstown, PA").up()
    .ele("PostalCode").txt(process.env.SHIP_FROM_ZIP || "17067").up()
    .ele("Site").txt("US").up();
}


// Fallback: Square resolved name → eBay Store category name (for mismatches)
const SQUARE_TO_STORE_FALLBACK = {
  "Beverage":              "Beverages & Drink Mixes",
  "Canned Meat":           "Canned Meats",
  "Pickled":               "Pickles",
  "Salad":                 "Salad Fixings",
  "Sauce":                 "Sauces",
  "Canning":               "Baking",
  "Citric Acid":           "Baking",
  "Ketchup":               "Condiment",
  "Domestic Pet Care":     "Wild Animal Care",
  "Home Pantry":           "Store Supplies",
  "Personal Care":         "Store Supplies",
  "The Grain Mill Cooperative": null,  // ignore
};

// Store category IDs are now managed dynamically via getOrCreateStoreCategory()
// The cache (storeCategoryCache) is populated from eBay on first use.
// STORE_CATEGORY_IDS kept as empty object for backward compatibility.
const STORE_CATEGORY_IDS = {};

// Load existing Store categories from eBay into cache
async function loadStoreCategoryCache() {
  const xml = create({ version: "1.0", encoding: "utf-8" })
    .ele("GetStoreRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("LevelLimit").txt("1").up()
    .up()
    .end({ prettyPrint: false });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(EBAY_API_URL, {
      method: "POST", headers: ebayHeaders("GetStore"), body: xml, signal: controller.signal
    });
    clearTimeout(timeout);
    const parsed = await parseXml(await res.text());
    const cats = [].concat(parsed?.GetStoreResponse?.Store?.CustomCategories?.CustomCategory || []);
    storeCategoryCache = {};
    cats.forEach(c => {
      if (c.Name && c.CategoryID) storeCategoryCache[String(c.Name)] = String(c.CategoryID);
    });
    console.log(`Loaded ${Object.keys(storeCategoryCache).length} Store categories from eBay`);
  } catch(e) {
    clearTimeout(timeout);
    storeCategoryCache = storeCategoryCache || {};
    console.warn("loadStoreCategoryCache failed:", e.message, "— using cached/empty");
  }
}

// Get or create a Store category by name.
// Checks cache first, then eBay, creates if missing.
async function getOrCreateStoreCategory(categoryName) {
  if (!categoryName) return null;

  // Apply fallback name mapping
  const mappedName = SQUARE_TO_STORE_FALLBACK.hasOwnProperty(categoryName)
    ? SQUARE_TO_STORE_FALLBACK[categoryName]
    : categoryName;
  if (mappedName === null) return null; // explicitly ignored

  // Load cache if not yet populated
  if (storeCategoryCache === null) {
    await loadStoreCategoryCache().catch(() => { storeCategoryCache = {}; });
  }

  // Return cached ID if exists
  if (storeCategoryCache[mappedName]) return storeCategoryCache[mappedName];

  // Create the category on eBay
  console.log(`Creating Store category: "${mappedName}"`);
  try {
    const xml = create({ version: "1.0", encoding: "utf-8" })
      .ele("SetStoreCategoriesRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
        .ele("RequesterCredentials")
          .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
        .up()
        .ele("Action").txt("Add").up()
        .ele("StoreCategories")
          .ele("CustomCategory")
            .ele("CategoryID").txt("-1").up()
            .ele("Name").txt(mappedName).up()
            .ele("Order").txt("999").up()
          .up()
        .up()
      .up()
      .end({ prettyPrint: false });

    const res = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("SetStoreCategories"), body: xml });
    const parsed = await parseXml(await res.text());
    const resp = parsed?.SetStoreCategoriesResponse;

    if (resp?.Ack === "Failure") {
      const errors = [].concat(resp?.Errors || []).map(e => e.ShortMessage).join("; ");
      console.error(`SetStoreCategories failed for "${mappedName}": ${errors}`);
      return null;
    }

    // Extract new ID from response
    const mappings = [].concat(resp?.CategoryMapping || []);
    const newId = mappings[0]?.NewCategoryID || null;
    if (newId) {
      storeCategoryCache[mappedName] = String(newId);
      console.log(`✓ Created Store category "${mappedName}" → ${newId}`);
      return String(newId);
    }

    // Reload cache to pick up new ID
    await loadStoreCategoryCache().catch(() => {});
    return storeCategoryCache[mappedName] || null;
  } catch(e) {
    console.error(`getOrCreateStoreCategory error for "${mappedName}":`, e.message);
    return null;
  }
}

// Alias for backward compatibility
async function getStoreCategoryId(categoryName) {
  return getOrCreateStoreCategory(categoryName);
}



app.use(express.json());
app.use(express.text({ type: "text/xml" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ── Config ──────────────────────────────────────────────────────────────────
const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || "production";
const SQUARE_BASE = SQUARE_ENV === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";

const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const EBAY_DEV_ID = process.env.EBAY_DEV_ID;
const EBAY_USER_TOKEN = process.env.EBAY_USER_TOKEN;
const EBAY_ENV = process.env.EBAY_ENV || "production";
const EBAY_API_URL = EBAY_ENV === "sandbox"
  ? "https://api.sandbox.ebay.com/ws/api.dll"
  : "https://api.ebay.com/ws/api.dll";

const MARKUP = parseFloat(process.env.MARKUP_PERCENT || "10") / 100;
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";

// ── Helpers ──────────────────────────────────────────────────────────────────
function squareHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-04-17",
    "Content-Type": "application/json",
  };
}

function ebayHeaders(callName) {
  return {
    "X-EBAY-API-SITEID": "0",
    "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-APP-NAME": EBAY_APP_ID,
    "X-EBAY-API-CERT-NAME": EBAY_CERT_ID,
    "X-EBAY-API-DEV-NAME": EBAY_DEV_ID,
    "Content-Type": "text/xml",
  };
}

async function parseXml(xmlStr) {
  try {
    return await xml2js.parseStringPromise(xmlStr, { explicitArray: false });
  } catch(e) {
    console.error("parseXml failed:", e.message);
    console.error("Raw response (first 500 chars):", String(xmlStr).substring(0, 500));
    throw new Error("XML parse error: " + e.message + " — raw: " + String(xmlStr).substring(0, 120));
  }
}

// ── Auth middleware for dashboard ────────────────────────────────────────────
function auth(req, res, next) {
  next();
}

// ── Square: search catalog ───────────────────────────────────────────────────
app.get("/api/square/products", auth, async (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  if (!q || q.length < 2) return res.json([]);

  try {
    // Search catalog items by name/description
    const searchRes = await fetch(`${SQUARE_BASE}/v2/catalog/search`, {
      method: "POST",
      headers: squareHeaders(),
      body: JSON.stringify({
        object_types: ["ITEM"],
        query: { text_query: { keywords: [q] } },
        limit: 50,
      }),
    });
    const searchData = await searchRes.json();
    if (!searchRes.ok) {
      return res.status(searchRes.status).json({ error: searchData.errors?.[0]?.detail || "Search failed" });
    }

    // Also search ITEM_VARIATION by SKU (Square text_query doesn't index SKUs on ITEM)
    let skuItems = [];
    try {
      const skuRes = await fetch(`${SQUARE_BASE}/v2/catalog/search`, {
        method: "POST",
        headers: squareHeaders(),
        body: JSON.stringify({
          object_types: ["ITEM_VARIATION"],
          query: { text_query: { keywords: [q] } },
          limit: 50,
        }),
      });
      const skuData = await skuRes.json();
      const variations = (skuData.objects || []).filter(v =>
        (v.item_variation_data?.sku || "").toLowerCase().includes(q)
      );
      // Collect parent item IDs
      const parentIds = [...new Set(variations.map(v => v.item_variation_data?.item_id).filter(Boolean))];
      if (parentIds.length) {
        const parentRes = await fetch(`${SQUARE_BASE}/v2/catalog/batch-retrieve`, {
          method: "POST",
          headers: squareHeaders(),
          body: JSON.stringify({ object_ids: parentIds }),
        });
        const parentData = await parentRes.json();
        skuItems = (parentData.objects || []).filter(o => o.type === "ITEM");
      }
    } catch(e) { /* SKU search optional */ }

    // Merge results, deduplicate by catalogId
    const seen = new Set((searchData.objects || []).map(o => o.id));
    const mergedObjects = [
      ...(searchData.objects || []),
      ...skuItems.filter(o => !seen.has(o.id)),
    ];
    searchData.objects = mergedObjects;

    // Collect image IDs to batch fetch
    const imageIds = [];
    const itemImageMap = {};
    (searchData.objects || []).forEach((obj) => {
      const imageId = obj.item_data?.image_id || (obj.item_data?.image_ids || [])[0];
      if (imageId) { imageIds.push(imageId); itemImageMap[obj.id] = imageId; }
    });

    // Batch fetch image URLs from Square
    let imageUrlMap = {};
    if (imageIds.length) {
      try {
        const imgRes = await fetch(`${SQUARE_BASE}/v2/catalog/batch-retrieve`, {
          method: "POST",
          headers: squareHeaders(),
          body: JSON.stringify({ object_ids: imageIds }),
        });
        const imgData = await imgRes.json();
        (imgData.objects || []).forEach((img) => {
          if (img.image_data?.url) imageUrlMap[img.id] = img.image_data.url;
        });
      } catch(e) { /* images optional */ }
    }

    // Collect ALL category IDs for hierarchy resolution
    const categoryIds = [];
    (searchData.objects || []).forEach((obj) => {
      const catId = obj.item_data?.category_id
        || (obj.item_data?.categories || [])[0]?.id
        || null;
      if (catId && !categoryIds.includes(catId)) categoryIds.push(catId);
    });

    // Batch fetch categories + walk parent hierarchy to find best Store category name.
    // Strategy: skip A-Z alphabet groupings (e.g. "A-C"), return highest meaningful ancestor.
    let categoryNameMap = {}; // leafId -> resolved Store category name
    if (categoryIds.length) {
      try {
        const catRes = await fetch(`${SQUARE_BASE}/v2/catalog/batch-retrieve`, {
          method: "POST",
          headers: squareHeaders(),
          body: JSON.stringify({ object_ids: categoryIds }),
        });
        const catData = await catRes.json();

        // Build id -> { name, parentId } map; collect parent IDs to fetch
        const catHierarchy = {};
        const parentIds = [];
        (catData.objects || []).forEach((cat) => {
          const parentId = cat.category_data?.parent_category?.id || null;
          catHierarchy[cat.id] = { name: cat.category_data?.name || "", parentId };
          if (parentId && !categoryIds.includes(parentId) && !parentIds.includes(parentId)) {
            parentIds.push(parentId);
          }
        });

        // Fetch parent categories (up to 5 rounds to handle deep hierarchies)
        let idsToFetch = parentIds.slice();
        for (let round = 0; round < 5; round++) {
          if (!idsToFetch.length) break;
          const pRes = await fetch(`${SQUARE_BASE}/v2/catalog/batch-retrieve`, {
            method: "POST", headers: squareHeaders(),
            body: JSON.stringify({ object_ids: idsToFetch }),
          });
          const pData = await pRes.json();
          const nextRound = [];
          (pData.objects || []).forEach((cat) => {
            const gpId = cat.category_data?.parent_category?.id || null;
            catHierarchy[cat.id] = { name: cat.category_data?.name || "", parentId: gpId };
            if (gpId && !catHierarchy[gpId] && !nextRound.includes(gpId)) nextRound.push(gpId);
          });
          idsToFetch = nextRound;
        }

        // Resolve: walk full chain leaf→root, strip A-Z alphabet groupings,
        // then return the FIRST item in the filtered chain (closest to root = department level).
        // e.g. Oatmeal→Hot Cereal→Breakfast→A-C becomes [Breakfast, Hot Cereal, Oatmeal] → "Breakfast"
        const isAlphaGroup = (name) => /^[A-Z][a-z]{0,2}(-[A-Z][a-z]{0,2})?$/.test(name.trim());
        const resolve = (leafId) => {
          const chain = [];
          let cur = leafId;
          const seen = new Set();
          while (cur && catHierarchy[cur] && !seen.has(cur)) {
            seen.add(cur);
            chain.push(catHierarchy[cur].name);
            cur = catHierarchy[cur].parentId;
          }
          // chain is leaf→root order, filter alpha groups, reverse to root→leaf
          const filtered = chain.filter(n => n && !isAlphaGroup(n)).reverse();
          // filtered[0] = highest non-alpha ancestor = department (e.g. "Breakfast")
          return filtered[0] || chain[0] || "";
        };

        categoryIds.forEach(id => { categoryNameMap[id] = resolve(id); });
        console.log("Resolved category names:", JSON.stringify(categoryNameMap));
      } catch(e) { console.error("Category fetch error:", e.message); }
    } else {
      const sample = (searchData.objects||[])[0];
      console.log("No category IDs found. Sample item_data keys:", Object.keys(sample?.item_data || {}).join(", "));
    }

    const items = (searchData.objects || []).map((obj) => {
      const itemData = obj.item_data || {};
      const variation = (itemData.variations || [])[0];
      const variationData = variation?.item_variation_data || {};
      const priceAmount = variationData.price_money?.amount || 0;
      const priceDollars = priceAmount / 100;
      const ebayPrice = parseFloat((priceDollars * (1 + MARKUP)).toFixed(2));
      const imageId = itemImageMap[obj.id];
      const categoryId = itemData.category_id
        || (itemData.categories || [])[0]?.id
        || "";
      const categoryName = categoryNameMap[categoryId] || "";

      return {
        catalogId: obj.id,
        variationId: variation?.id || null,
        name: itemData.name || "Unnamed",
        description: itemData.description || "",
        sku: variationData.sku || "",
        category: categoryName,
        squarePrice: priceDollars,
        ebayPrice,
        inStock: variationData.track_inventory === false || true,
        imageUrl: imageId ? (imageUrlMap[imageId] || "") : "",
        weightRaw: JSON.stringify(variationData.weight || null),
        weight: (function() {
          // 1. Try SKU lookup table first
          const sku = variationData.sku ? String(variationData.sku).trim() : null;
          if (sku && WEIGHT_LOOKUP[sku]) return WEIGHT_LOOKUP[sku];
          // 2. Try Square's native weight field
          if (variationData.weight && variationData.weight.value) {
            return variationData.weight.unit === "KILOGRAM"
              ? parseFloat((variationData.weight.value * 2.20462).toFixed(3))
              : parseFloat(variationData.weight.value);
          }
          return null;
        })(),
      };
    });

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── eBay: list item ──────────────────────────────────────────────────────────
app.post("/api/ebay/list", auth, async (req, res) => {
  const { name, description, sku, ebayPrice, quantity, categoryId, conditionId, markup, imageUrl, brand, itemType, weightLbs } = req.body;

  if (!name || !ebayPrice) return res.status(400).json({ error: "Missing required fields" });
  if (!brand) return res.status(400).json({ error: "Brand is required by eBay" });
  if (!itemType) return res.status(400).json({ error: "Type is required by eBay" });
  if (!weightLbs || isNaN(weightLbs)) return res.status(400).json({ error: "Weight is required by eBay" });

  // Apply custom markup if provided
  const finalPrice = markup !== undefined
    ? parseFloat((ebayPrice * (1 + parseFloat(markup) / 100)).toFixed(2))
    : ebayPrice;

  // Split weight into whole pounds and ounces for eBay
  const totalOz = Math.round(parseFloat(weightLbs) * 16);
  const weightPounds = Math.floor(totalOz / 16);
  const weightOunces = totalOz % 16;

  // Categories where eBay does not allow ConditionID
  const noConditionCategories = ["14308", "181000", "3025"];
  const skipCondition = noConditionCategories.includes(String(categoryId));

  // Resolve Store category from Square product category name
  const storeCatId = await getStoreCategoryId(req.body.squareCategory || "").catch(() => null);

  let itemNode = create({ version: "1.0", encoding: "utf-8" })
    .ele("AddFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("Item")
        .ele("Title").txt(name.substring(0, 80)).up()
        .ele("Description").txt(description || name).up()
        .ele("PrimaryCategory")
          .ele("CategoryID").txt(String(categoryId || "14308")).up()
        .up()
        .ele("StartPrice").txt(String(finalPrice)).up();

  // Attach Store category if resolved
  if (storeCatId) {
    itemNode = itemNode
      .ele("Storefront")
        .ele("StoreCategoryID").txt(String(storeCatId)).up()
      .up();
  }

  // Only add ConditionID for categories that support it
  if (!skipCondition) {
    itemNode = itemNode.ele("ConditionID").txt(String(conditionId || "1000")).up();
  }

  itemNode = itemNode
        .ele("Country").txt("US").up()
        .ele("Currency").txt("USD").up()
        .ele("DispatchTimeMax").txt("3").up()
        .ele("ListingDuration").txt("GTC").up()
        .ele("ListingType").txt("FixedPriceItem").up()
        .ele("Quantity").txt(String(quantity || 1)).up()
        .ele("SKU").txt(sku || "").up();

  // Add photo if available
  if (imageUrl) {
    itemNode = itemNode
      .ele("PictureDetails")
        .ele("PictureURL").txt(imageUrl).up()
      .up();
  }

  // Add Brand, Type, and Product as item specifics
  itemNode = itemNode
    .ele("ItemSpecifics")
      .ele("NameValueList")
        .ele("Name").txt("Brand").up()
        .ele("Value").txt(brand).up()
      .up()
      .ele("NameValueList")
        .ele("Name").txt("Type").up()
        .ele("Value").txt(itemType).up()
      .up()
      .ele("NameValueList")
        .ele("Name").txt("Product").up()
        .ele("Value").txt(name.substring(0, 65)).up()
      .up()
    .up();

  const xml = (await buildPolicyXml(itemNode, { weightPounds, weightOunces, pkgDepth: 0, pkgWidth: 0, pkgHeight: 0 }))
      .up()
    .up()
    .end({ prettyPrint: false });

  // Log the XML being sent for debugging
  console.log("=== EBAY XML BEING SENT ===");
  console.log(xml);
  console.log("=== END XML ===");

  try {
    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("AddFixedPriceItem"),
      body: xml,
    });
    const xmlText = await ebayRes.text();
    console.log("=== EBAY RESPONSE ===");
    console.log(xmlText);
    console.log("=== END RESPONSE ===");
    const parsed = await parseXml(xmlText);
    const resp = parsed?.AddFixedPriceItemResponse;

    if (resp?.Ack === "Failure" || resp?.Ack === "PartialFailure") {
      const errors = [].concat(resp?.Errors || []);
      const msg = errors.map((e) => e.LongMessage || e.ShortMessage).join("; ");
      return res.status(400).json({ error: msg });
    }

    // Invalidate active listings cache so Search & Add reflects the new listing immediately
    activeListingsCache = null;

    res.json({
      success: true,
      itemId: resp?.ItemID,
      fees: resp?.Fees,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── eBay: get categories (for dropdown) ─────────────────────────────────────
// ── GET fetch actual Store categories from eBay ───────────────────────────────
app.get("/api/ebay/store-categories", auth, (req, res) => {
  res.json(STORE_CATEGORY_IDS);
});

app.post("/api/ebay/store-categories", auth, (req, res) => {
  // Add or update a Store category name → ID mapping manually
  const { name, id } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const STORE_CATS_PATH = path.join(__dirname, "store_categories.json");
  let cats = {};
  try { cats = JSON.parse(fs.readFileSync(STORE_CATS_PATH, "utf8")); } catch(e) {}
  cats[name] = id || name; // use name as ID if no ID provided
  fs.writeFileSync(STORE_CATS_PATH, JSON.stringify(cats, null, 2));
  storeCategoryCache = cats;
  res.json({ success: true });
});

app.delete("/api/ebay/store-categories/:name", auth, (req, res) => {
  const STORE_CATS_PATH = path.join(__dirname, "store_categories.json");
  let cats = {};
  try { cats = JSON.parse(fs.readFileSync(STORE_CATS_PATH, "utf8")); } catch(e) {}
  delete cats[decodeURIComponent(req.params.name)];
  fs.writeFileSync(STORE_CATS_PATH, JSON.stringify(cats, null, 2));
  storeCategoryCache = cats;
  res.json({ success: true });
});



// ── Diagnostic: show what Square categories resolve to ───────────────────────
app.get("/api/debug/categories", auth, async (req, res) => {
  try {
    // Paginate through all Square categories
    let allCats = [];
    let cursor = null;
    do {
      const url = `${SQUARE_BASE}/v2/catalog/list?types=CATEGORY${cursor ? `&cursor=${cursor}` : ''}`;
      const catRes = await fetch(url, { headers: squareHeaders() });
      const catData = await catRes.json();
      allCats = allCats.concat(catData.objects || []);
      cursor = catData.cursor || null;
    } while (cursor);

    const cats = allCats.map(c => ({
      id: c.id,
      name: c.category_data?.name || "",
      parentId: c.category_data?.parent_category?.id || null,
    }));

    // Build hierarchy map
    const catMap = {};
    cats.forEach(c => { catMap[c.id] = { name: c.name, parentId: c.parentId }; });

    const isAlphaGroup = (name) => /^[A-Z][a-z]{0,2}(-[A-Z][a-z]{0,2})?$/.test(name.trim());
    const resolve = (leafId) => {
      const chain = [];
      let cur = leafId;
      const seen = new Set();
      while (cur && catMap[cur] && !seen.has(cur)) {
        seen.add(cur);
        chain.push(catMap[cur].name);
        cur = catMap[cur].parentId;
      }
      const filtered = chain.filter(n => n && !isAlphaGroup(n)).reverse();
      return { resolved: filtered[0] || chain[0] || "", chain: chain.reverse() };
    };

    // Show only unique resolved names with match status
    const seen = new Set();
    const resolveMatch = (name) => {
      if (STORE_CATEGORY_IDS[name]) return true;
      const fb = SQUARE_TO_STORE_FALLBACK[name];
      if (fb === null) return "ignored";
      return !!(fb && STORE_CATEGORY_IDS[fb]);
    };
    const result = cats
      .map(c => {
        const r = resolve(c.id);
        return { ...r, squareName: c.name, ebayStoreMatch: resolveMatch(r.resolved) };
      })
      .filter(c => { if (seen.has(c.resolved)) return false; seen.add(c.resolved); return true; })
      .sort((a, b) => a.resolved.localeCompare(b.resolved));

    res.json({ totalCats: cats.length, storeIds: STORE_CATEGORY_IDS, resolvedCategories: result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/square/categories", auth, async (req, res) => {
  try {
    const response = await fetch(`${SQUARE_BASE}/v2/catalog/list?types=CATEGORY`, {
      headers: squareHeaders(),
    });
    const data = await response.json();
    const cats = (data.objects || [])
      .map(c => ({ id: c.id, name: c.category_data?.name || "" }))
      .filter(c => c.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(cats);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Store category map: Square category name → eBay Store category name ───────
// Stored in store_category_map.json, editable via the Categories tab.
const STORE_MAP_PATH = path.join(__dirname, "store_category_map.json");

function loadStoreMap() {
  try { return JSON.parse(fs.readFileSync(STORE_MAP_PATH, "utf8")); }
  catch(e) { return {}; }
}

function saveStoreMap(map) {
  fs.writeFileSync(STORE_MAP_PATH, JSON.stringify(map, null, 2));
}

app.get("/api/store-map", auth, (req, res) => res.json(loadStoreMap()));

app.post("/api/store-map", auth, (req, res) => {
  const { squareName, storeName } = req.body;
  if (!squareName || !storeName) return res.status(400).json({ error: "squareName and storeName required" });
  const map = loadStoreMap();
  map[squareName] = storeName;
  saveStoreMap(map);
  // Bust store category cache
  storeCategoryCache = null;
  res.json({ success: true });
});

app.delete("/api/store-map/:name", auth, (req, res) => {
  const map = loadStoreMap();
  delete map[decodeURIComponent(req.params.name)];
  saveStoreMap(map);
  res.json({ success: true });
});




app.get("/api/ebay/category-name", auth, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id required" });
  try {
    const xml = create({ version: "1.0", encoding: "utf-8" })
      .ele("GetCategoriesRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
        .ele("RequesterCredentials")
          .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
        .up()
        .ele("CategoryParent").txt(String(id)).up()
        .ele("LevelLimit").txt("1").up()
        .ele("ViewAllNodes").txt("true").up()
      .up()
      .end({ prettyPrint: false });

    const ebayRes = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("GetCategories"), body: xml });
    const parsed = await parseXml(await ebayRes.text());
    const cats = [].concat(parsed?.GetCategoriesResponse?.CategoryArray?.Category || []);
    const match = cats.find(c => String(c.CategoryID) === String(id));
    if (match) {
      res.json({ id: match.CategoryID, name: match.CategoryName, leaf: match.LeafCategory });
    } else {
      res.json({ id, name: "Not found", leaf: false });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ebay/categories", auth, async (req, res) => {
  const parentId = req.query.parentId || "-1";
  const xml = create({ version: "1.0", encoding: "utf-8" })
    .ele("GetCategoriesRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("CategoryParent").txt(String(parentId)).up()
      .ele("LevelLimit").txt("2").up()
      .ele("ViewAllNodes").txt("true").up()
    .up()
    .end({ prettyPrint: false });

  try {
    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("GetCategories"),
      body: xml,
    });
    const xmlText = await ebayRes.text();
    const parsed = await parseXml(xmlText);
    const cats = [].concat(parsed?.GetCategoriesResponse?.CategoryArray?.Category || []);
    const simplified = cats.map((c) => ({
      id: c.CategoryID,
      name: c.CategoryName,
      level: c.CategoryLevel,
    })).sort((a, b) => a.name?.localeCompare(b.name));
    res.json(simplified);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Quick browser test for food categories (no auth, read-only) ───────────────
app.get("/api/test/categories", async (req, res) => {
  try {
    const xml = create({ version: "1.0", encoding: "utf-8" })
      .ele("GetCategoriesRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
        .ele("RequesterCredentials")
          .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
        .up()
        .ele("CategoryParent").txt("14308").up()
        .ele("LevelLimit").txt("2").up()
        .ele("DetailLevel").txt("ReturnAll").up()
      .up()
      .end({ prettyPrint: false });

    console.log("TEST XML:", xml.substring(0, 300));
    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("GetCategories"),
      body: xml,
    });
    const rawText = await ebayRes.text();
    console.log("TEST HTTP status:", ebayRes.status);
    console.log("TEST raw (first 500):", rawText.substring(0, 500));
    res.setHeader("Content-Type", "text/plain");
    res.send(`HTTP ${ebayRes.status}\n\n${rawText.substring(0, 3000)}`);
  } catch(e) {
    res.status(500).send("Error: " + e.message);
  }
});


app.get("/api/ebay/food-categories", auth, async (req, res) => {
  try {
    // Fetch from isoldwhat.com which scrapes eBay nightly — most reliable source
    // eBay's own GetCategories API is blocked at their CDN for this app
    const response = await fetch(
      "https://www.isoldwhat.com/?1=1&RootID=11700&L2C=14308&L3C=257942",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; GrainMillBot/1.0)" } }
    );
    const html = await response.text();

    // Parse category IDs and names from isoldwhat anchor tags
    // Format: [Category Name](url#NNNNN) # NNNNN (leaf) or just # NNNNN
    const categories = [];
    const seen = new Set();
    const lineRegex = /\[([^\]]+)\][^\n#]*#\s*(\d{4,6})(?:\s*\(leaf\))?/g;
    let m;
    while ((m = lineRegex.exec(html)) !== null) {
      const name = m[1].replace(/\s+/g, ' ').trim();
      const id = m[2];
      if (!seen.has(id) && parseInt(id) > 14000) {
        seen.add(id);
        const isLeaf = html.includes(`#${id} *(leaf)*`) || html.includes(`#${id} (leaf)`);
        categories.push({ id, name, isLeaf });
      }
    }

    const ourMappedIds = new Set(Object.keys(EBAY_TO_STORE_CATEGORY));
    const result = categories
      .map(c => ({ ...c, inOurMap: ourMappedIds.has(c.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`food-categories: found ${result.length} categories from isoldwhat.com`);
    res.json({ categories: result, ourMappedIds: [...ourMappedIds] });
  } catch(e) {
    console.error("food-categories error:", e.message);
    // Fallback: return our known map as static data so UI still works
    const ourMappedIds = Object.keys(EBAY_TO_STORE_CATEGORY);
    const fallback = ourMappedIds.map(id => ({
      id, name: EBAY_TO_STORE_CATEGORY[id], isLeaf: true, inOurMap: true
    })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ categories: fallback, ourMappedIds, fallback: true });
  }
})


// ── POST update a single category mapping ─────────────────────────────────────
// Updates EBAY_TO_STORE_CATEGORY in memory and saves to category_overrides.json
const CATEGORY_OVERRIDES_PATH = path.join(__dirname, "category_overrides.json");

function loadCategoryOverrides() {
  try { return JSON.parse(fs.readFileSync(CATEGORY_OVERRIDES_PATH, "utf8")); }
  catch(e) { return {}; }
}

// Merge overrides into EBAY_TO_STORE_CATEGORY on startup
(function applyCategoryOverrides() {
  const overrides = loadCategoryOverrides();
  Object.assign(EBAY_TO_STORE_CATEGORY, overrides);
  if (Object.keys(overrides).length) {
    console.log(`Applied ${Object.keys(overrides).length} category override(s) from file`);
  }
})();

app.post("/api/ebay/category-map", auth, (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: "id and name required" });

  // Update in-memory map
  EBAY_TO_STORE_CATEGORY[String(id)] = name;

  // Persist to overrides file
  const overrides = loadCategoryOverrides();
  overrides[String(id)] = name;
  fs.writeFileSync(CATEGORY_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));

  // Bust store category cache so new IDs get created on next listing
  storeCategoryCache = null;

  console.log(`Category map updated: ${id} → "${name}"`);
  res.json({ success: true, id, name });
});

// ── DELETE remove a category mapping ─────────────────────────────────────────
app.delete("/api/ebay/category-map/:id", auth, (req, res) => {
  const id = req.params.id;
  delete EBAY_TO_STORE_CATEGORY[id];
  const overrides = loadCategoryOverrides();
  delete overrides[id];
  fs.writeFileSync(CATEGORY_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
  storeCategoryCache = null;
  res.json({ success: true });
});



// ── eBay: webhook — order notification ───────────────────────────────────────
// eBay sends a POST to this endpoint when an order is placed
app.post("/webhook/ebay-order", async (req, res) => {
  // Acknowledge immediately so eBay doesn't retry
  res.status(200).send("OK");

  try {
    let body = req.body;

    // Parse XML if needed
    if (typeof body === "string") {
      body = await parseXml(body);
    }

    // Extract order data from eBay notification
    const notification = body?.soapenv_Envelope?.["soapenv:Body"]
      || body?.["soapenv:Envelope"]?.["soapenv:Body"]
      || body;

    const orderDetail = notification?.GetItemTransactionsResponse
      || notification?.GetOrdersResponse
      || null;

    // Pull out what we need — eBay notification format varies
    // We do a GetOrders call to get full details when we receive any sale notification
    await syncLatestEbayOrders();
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

// ── Pull recent eBay orders and create in Square ─────────────────────────────
async function syncLatestEbayOrders() {
  try {
    // Get orders from last 24 hours
    const now = new Date();
    const yesterday = new Date(now - 24 * 60 * 60 * 1000);
    const fromDate = yesterday.toISOString().replace(/\.\d{3}Z$/, ".000Z");

    const xml = create({ version: "1.0", encoding: "utf-8" })
      .ele("GetOrdersRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
        .ele("RequesterCredentials")
          .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
        .up()
        .ele("CreateTimeFrom").txt(fromDate).up()
        .ele("CreateTimeTo").txt(now.toISOString().replace(/\.\d{3}Z$/, ".000Z")).up()
        .ele("OrderRole").txt("Seller").up()
        .ele("OrderStatus").txt("Completed").up()
      .up()
      .end({ prettyPrint: false });

    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("GetOrders"),
      body: xml,
    });
    const xmlText = await ebayRes.text();
    const parsed = await parseXml(xmlText);
    const orders = [].concat(
      parsed?.GetOrdersResponse?.OrderArray?.Order || []
    );

    for (const order of orders) {
      await createSquareOrderFromEbay(order);
      await topUpQuantityForOrder(order);
    }
  } catch (e) {
    console.error("syncLatestEbayOrders error:", e.message);
  }
}

// ── Top up eBay quantity to 5 after a sale ───────────────────────────────────
const LISTING_QUANTITY = 5;

async function topUpQuantityForOrder(ebayOrder) {
  try {
    const transactions = [].concat(ebayOrder.TransactionArray?.Transaction || []);
    for (const t of transactions) {
      const itemId = t.Item?.ItemID;
      if (!itemId) continue;

      const xml = create({ version: "1.0", encoding: "utf-8" })
        .ele("ReviseFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
          .ele("RequesterCredentials")
            .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
          .up()
          .ele("Item")
            .ele("ItemID").txt(String(itemId)).up()
            .ele("Quantity").txt(String(LISTING_QUANTITY)).up()
          .up()
        .up()
        .end({ prettyPrint: false });

      const res = await fetch(EBAY_API_URL, {
        method: "POST",
        headers: ebayHeaders("ReviseFixedPriceItem"),
        body: xml,
      });
      const parsed = await parseXml(await res.text());
      const resp = parsed?.ReviseFixedPriceItemResponse;
      if (resp?.Ack === "Failure") {
        const errors = [].concat(resp?.Errors || []);
        console.error(`topUp failed for item ${itemId}:`, errors.map(e => e.ShortMessage).join("; "));
      } else {
        console.log(`✓ Quantity topped up to ${LISTING_QUANTITY} for eBay item ${itemId}`);
      }
    }
  } catch (e) {
    console.error("topUpQuantityForOrder error:", e.message);
  }
}

// ── Check Square for not-for-sale items and remove from eBay ─────────────────
async function removeUnsellableFromEbay() {
  console.log("Running not-for-sale check…");
  try {
    // 1. Get all active eBay listings with SKUs — capture full item details for relist
    const ebayItemMap = {}; // sku -> { itemId, title, price, ... }
    for (let page = 1; page <= 10; page++) {
      const xml = create({ version: "1.0", encoding: "utf-8" })
        .ele("GetMyeBaySellingRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
          .ele("RequesterCredentials")
            .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
          .up()
          .ele("ActiveList")
            .ele("Include").txt("true").up()
            .ele("Pagination")
              .ele("EntriesPerPage").txt("50").up()
              .ele("PageNumber").txt(String(page)).up()
            .up()
          .up()
          .ele("DetailLevel").txt("ReturnAll").up()
        .up()
        .end({ prettyPrint: false });

      const res = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("GetMyeBaySelling"), body: xml });
      const parsed = await parseXml(await res.text());
      const resp = parsed?.GetMyeBaySellingResponse;
      const items = [].concat(resp?.ActiveList?.ItemArray?.Item || []);
      items.forEach(item => {
        if (item.SKU) {
          const sku = String(item.SKU);
          const price = parseFloat(
            item.SellingStatus?.CurrentPrice?.["_"] ||
            item.BuyItNowPrice?.["_"] ||
            item.StartPrice?.["_"] || "0"
          );
          ebayItemMap[sku] = {
            itemId: item.ItemID,
            title: item.Title || "",
            ebayPrice: price,
            quantity: parseInt(item.QuantityAvailable || item.Quantity || "5"),
          };
        }
      });
      const totalPages = parseInt(resp?.ActiveList?.PaginationResult?.TotalNumberOfPages || "1");
      if (page >= totalPages) break;
    }

    const listedSkus = Object.keys(ebayItemMap);
    if (!listedSkus.length) { console.log("No active eBay listings to check."); return; }

    // 2. Check each SKU against Square — look for not-for-sale status
    const unsellableSkus = [];
    for (const sku of listedSkus) {
      try {
        const res = await fetch(`${SQUARE_BASE}/v2/catalog/search`, {
          method: "POST",
          headers: squareHeaders(),
          body: JSON.stringify({
            object_types: ["ITEM_VARIATION"],
            query: { exact_query: { attribute_name: "sku", attribute_value: sku } },
          }),
        });
        const data = await res.json();
        const variations = data.objects || [];
        for (const v of variations) {
          const vd = v.item_variation_data || {};
          if (vd.sellable === false || vd.available_for_purchase === false) {
            unsellableSkus.push(sku);
            break;
          }
        }
      } catch(e) {
        console.error(`SKU check error for ${sku}:`, e.message);
      }
    }

    if (!unsellableSkus.length) {
      console.log("All listed SKUs are still sellable in Square.");
      return;
    }

    // 3. Fetch full listing details via GetItem, then end + save for relist
    for (const sku of unsellableSkus) {
      const { itemId, title, ebayPrice, quantity } = ebayItemMap[sku];
      console.log(`Removing eBay listing ${itemId} (SKU: ${sku}) — marked not for sale in Square`);

      // Fetch full item details so we can relist later
      let savedEntry = { sku, itemId, title, ebayPrice, quantity };
      try {
        const getXml = create({ version: "1.0", encoding: "utf-8" })
          .ele("GetItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
            .ele("RequesterCredentials")
              .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
            .up()
            .ele("ItemID").txt(String(itemId)).up()
            .ele("DetailLevel").txt("ReturnAll").up()
          .up()
          .end({ prettyPrint: false });

        const getRes = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("GetItem"), body: getXml });
        const getParsed = await parseXml(await getRes.text());
        const item = getParsed?.GetItemResponse?.Item;

        if (item) {
          const unwrap = v => v == null ? "" : typeof v === "object" ? (v?._ || v?.["$t"] || Object.values(v)[0] || "") : String(v);
          const specs = [].concat(item.ItemSpecifics?.NameValueList || []);
          const brand = unwrap(specs.find(s => unwrap(s.Name) === "Brand")?.Value) || "";
          const itemType = unwrap(specs.find(s => unwrap(s.Name) === "Type")?.Value) || "";
          const rawMaj = item.ShippingPackageDetails?.WeightMajor;
          const rawMin = item.ShippingPackageDetails?.WeightMinor;
          const wMajor = parseInt((typeof rawMaj === "object" ? rawMaj?._ || rawMaj?.["$t"] || "0" : rawMaj) || "0");
          const wMinor = parseInt((typeof rawMin === "object" ? rawMin?._ || rawMin?.["$t"] || "0" : rawMin) || "0");
          let weightLbs = wMajor > 0 ? parseFloat((wMajor + wMinor / 16).toFixed(3)) : 0;
          if (!weightLbs && sku && WEIGHT_LOOKUP[sku]) weightLbs = WEIGHT_LOOKUP[sku];
          if (!weightLbs && title) { const m = title.match(/(\d+(?:\.\d+)?)\s*lb/i); if (m) weightLbs = parseFloat(m[1]); }
          const imageUrl = unwrap([].concat(item.PictureDetails?.PictureURL || [])[0]) || "";
          const description = unwrap(item.Description) || "";
          const categoryId = unwrap(item.PrimaryCategory?.CategoryID) || "";
          const conditionId = unwrap(item.ConditionID) || "1000";

          savedEntry = {
            sku, itemId, title,
            ebayPrice: parseFloat(unwrap(item.StartPrice) || ebayPrice) || ebayPrice,
            quantity: parseInt(unwrap(item.Quantity) || quantity) || quantity,
            brand, itemType, weightLbs, imageUrl, description,
            categoryId, conditionId,
          };
        }
      } catch(e) {
        console.error(`GetItem failed for ${itemId}:`, e.message);
      }

      // Save to ended listings store
      addEndedListing(savedEntry);

      // End the eBay listing
      try {
        const xml = create({ version: "1.0", encoding: "utf-8" })
          .ele("EndFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
            .ele("RequesterCredentials")
              .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
            .up()
            .ele("ItemID").txt(String(itemId)).up()
            .ele("EndingReason").txt("NotAvailable").up()
          .up()
          .end({ prettyPrint: false });

        const res = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("EndFixedPriceItem"), body: xml });
        const parsed = await parseXml(await res.text());
        const resp = parsed?.EndFixedPriceItemResponse;
        if (resp?.Ack === "Failure") {
          const errors = [].concat(resp?.Errors || []);
          console.error(`Failed to end listing ${itemId}:`, errors.map(e => e.ShortMessage).join("; "));
          // Don't save ended entry if we couldn't actually end it
          removeEndedListing(sku);
        } else {
          console.log(`✓ Ended eBay listing ${itemId} for SKU ${sku}, saved for relist`);
        }
      } catch(e) {
        console.error(`End listing error for ${itemId}:`, e.message);
        removeEndedListing(sku);
      }
    }
  } catch (e) {
    console.error("removeUnsellableFromEbay error:", e.message);
  }
}

// ── Relist a single ended listing on eBay ────────────────────────────────────
async function relistOnEbay(entry) {
  const { sku, title, ebayPrice, quantity, categoryId, conditionId,
          brand, itemType, weightLbs, imageUrl, description } = entry;

  if (!title || !ebayPrice) throw new Error("Missing title or price in saved listing data");

  const totalOz = Math.round(parseFloat(weightLbs || 1) * 16);
  const weightPounds = Math.floor(totalOz / 16);
  const weightOunces = totalOz % 16;

  const noConditionCategories = ["14308", "181000", "3025"];
  const skipCondition = noConditionCategories.includes(String(categoryId));

  // Resolve Store category (create if needed)
  const storeCatId = await getOrCreateStoreCategory(categoryId).catch(() => null);

  let itemNode = create({ version: "1.0", encoding: "utf-8" })
    .ele("AddFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("Item")
        .ele("Title").txt(String(title).substring(0, 80)).up()
        .ele("Description").txt(description || title).up()
        .ele("PrimaryCategory")
          .ele("CategoryID").txt(String(categoryId || "14308")).up()
        .up()
        .ele("StartPrice").txt(String(ebayPrice)).up();

  // Attach Store category if resolved
  if (storeCatId) {
    itemNode = itemNode
      .ele("Storefront")
        .ele("StoreCategoryID").txt(String(storeCatId)).up()
      .up();
  }


  if (!skipCondition) {
    itemNode = itemNode.ele("ConditionID").txt(String(conditionId || "1000")).up();
  }

  itemNode = itemNode
      .ele("Country").txt("US").up()
      .ele("Currency").txt("USD").up()
      .ele("DispatchTimeMax").txt("3").up()
      .ele("ListingDuration").txt("GTC").up()
      .ele("ListingType").txt("FixedPriceItem").up()
      .ele("Quantity").txt(String(quantity || 5)).up()
      .ele("SKU").txt(sku || "").up();

  if (imageUrl) {
    itemNode = itemNode
      .ele("PictureDetails")
        .ele("PictureURL").txt(imageUrl).up()
      .up();
  }

  if (brand || itemType) {
    let specs = itemNode.ele("ItemSpecifics");
    if (brand) specs = specs.ele("NameValueList").ele("Name").txt("Brand").up().ele("Value").txt(brand).up().up();
    if (itemType) specs = specs.ele("NameValueList").ele("Name").txt("Type").up().ele("Value").txt(itemType).up().up();
    specs.ele("NameValueList").ele("Name").txt("Product").up().ele("Value").txt(String(title).substring(0, 65)).up().up();
    itemNode = specs.up();
  }

  const xml = (await buildPolicyXml(itemNode, { weightPounds, weightOunces, pkgDepth: 0, pkgWidth: 0, pkgHeight: 0 }))
    .up()
  .up()
  .end({ prettyPrint: false });

  const ebayRes = await fetch(EBAY_API_URL, {
    method: "POST",
    headers: ebayHeaders("AddFixedPriceItem"),
    body: xml,
  });
  const xmlText = await ebayRes.text();
  const parsed = await parseXml(xmlText);
  const resp = parsed?.AddFixedPriceItemResponse;

  if (resp?.Ack === "Failure" || resp?.Ack === "PartialFailure") {
    const errors = [].concat(resp?.Errors || []);
    throw new Error(errors.map(e => e.LongMessage || e.ShortMessage).join("; "));
  }

  return resp?.ItemID;
}

// ── Daily job: auto-relist ended listings that are sellable again in Square ──
async function checkAndRelistFromSquare() {
  console.log("Running daily auto-relist check…");
  const store = loadEndedListings();
  const skus = Object.keys(store);
  if (!skus.length) { console.log("No ended listings to check."); return; }

  for (const sku of skus) {
    const entry = store[sku];
    try {
      const res = await fetch(`${SQUARE_BASE}/v2/catalog/search`, {
        method: "POST",
        headers: squareHeaders(),
        body: JSON.stringify({
          object_types: ["ITEM_VARIATION"],
          query: { exact_query: { attribute_name: "sku", attribute_value: sku } },
        }),
      });
      const data = await res.json();
      const variations = data.objects || [];

      let isSellable = false;
      for (const v of variations) {
        const vd = v.item_variation_data || {};
        if (vd.sellable !== false && vd.available_for_purchase !== false) {
          isSellable = true;
          break;
        }
      }

      if (!isSellable) {
        console.log(`SKU ${sku} still not sellable in Square, skipping.`);
        continue;
      }

      console.log(`SKU ${sku} is sellable again — relisting on eBay…`);
      const newItemId = await relistOnEbay(entry);
      console.log(`✓ Auto-relisted SKU ${sku} as eBay item ${newItemId}`);
      removeEndedListing(sku);
    } catch(e) {
      console.error(`Auto-relist failed for SKU ${sku}:`, e.message);
    }
  }
}

// ── Run not-for-sale check every 6 hours ─────────────────────────────────────
setInterval(removeUnsellableFromEbay, 6 * 60 * 60 * 1000);
// Also run once at startup (after 30s to let server settle)
setTimeout(removeUnsellableFromEbay, 30 * 1000);

// ── Run auto-relist check once daily ─────────────────────────────────────────
setInterval(checkAndRelistFromSquare, 24 * 60 * 60 * 1000);
setTimeout(checkAndRelistFromSquare, 60 * 1000); // first check 60s after startup

// ── GET ended listings ────────────────────────────────────────────────────────
app.get("/api/ebay/ended-listings", auth, async (req, res) => {
  try {
    // Query eBay directly for ended/unsold listings
    const allItems = [];
    for (let page = 1; page <= 10; page++) {
      const xml = create({ version: "1.0", encoding: "utf-8" })
        .ele("GetMyeBaySellingRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
          .ele("RequesterCredentials")
            .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
          .up()
          .ele("UnsoldList")
            .ele("Include").txt("true").up()
            .ele("DurationInDays").txt("60").up()
            .ele("Pagination")
              .ele("EntriesPerPage").txt("100").up()
              .ele("PageNumber").txt(String(page)).up()
            .up()
          .up()
          .ele("DetailLevel").txt("ReturnAll").up()
        .up()
        .end({ prettyPrint: false });

      const ebayRes = await fetch(EBAY_API_URL, {
        method: "POST",
        headers: ebayHeaders("GetMyeBaySelling"),
        body: xml,
      });
      const parsed = await parseXml(await ebayRes.text());
      const resp = parsed?.GetMyeBaySellingResponse;
      const items = [].concat(resp?.UnsoldList?.ItemArray?.Item || []);
      allItems.push(...items);
      const totalPages = parseInt(resp?.UnsoldList?.PaginationResult?.TotalNumberOfPages || "1");
      if (page >= totalPages || !items.length) break;
    }

    // Also merge in any entries from the local file that eBay may not show
    // (e.g. items ended more than 60 days ago that haven't been relisted)
    const localStore = loadEndedListings();

    // Build a Set of SKUs already covered by eBay results
    const ebaySKUs = new Set(allItems.map(i => i.SKU).filter(Boolean));

    const liveList = allItems.map(item => {
      const sku = item.SKU || "";
      const local = localStore[sku] || {};
      // Extract weight safely
      const rawMaj = item.ShippingPackageDetails?.WeightMajor;
      const rawMin = item.ShippingPackageDetails?.WeightMinor;
      const wMaj = parseInt((typeof rawMaj === "object" ? rawMaj?._ || "0" : rawMaj) || "0");
      const wMin = parseInt((typeof rawMin === "object" ? rawMin?._ || "0" : rawMin) || "0");
      const weightLbs = wMaj > 0 ? wMaj + wMin / 16
        : (sku && WEIGHT_LOOKUP[sku]) ? WEIGHT_LOOKUP[sku]
        : local.weightLbs || null;

      const endTime = item.ListingDetails?.EndTime || item.EndTime || local.endedAt || null;
      const price = parseFloat(
        item.BuyItNowPrice?._ || item.BuyItNowPrice ||
        item.StartPrice?._ || item.StartPrice ||
        local.ebayPrice || 0
      );

      return {
        itemId: item.ItemID || local.itemId || "",
        sku,
        title: item.Title || local.title || "",
        ebayPrice: price,
        weightLbs,
        endedAt: endTime,
        imageUrl: [].concat(item.PictureDetails?.PictureURL || [])[0] || local.imageUrl || "",
        categoryId: item.PrimaryCategory?.CategoryID || local.categoryId || "",
        conditionId: item.ConditionID || local.conditionId || "1000",
        description: item.Description || local.description || "",
        brand: [].concat(item.ItemSpecifics?.NameValueList || []).find(s => s.Name === "Brand")?.Value || local.brand || "",
        itemType: [].concat(item.ItemSpecifics?.NameValueList || []).find(s => s.Name === "Type")?.Value || local.itemType || "",
        quantity: parseInt(item.Quantity || local.quantity || 5),
        source: "ebay",
      };
    });

    // Add local-only entries (not in eBay results) so relist still works
    const localOnly = Object.values(localStore)
      .filter(e => !ebaySKUs.has(e.sku))
      .map(e => ({ ...e, source: "local" }));

    const combined = [...liveList, ...localOnly]
      .sort((a, b) => new Date(b.endedAt || 0) - new Date(a.endedAt || 0));

    res.json(combined);
  } catch(e) {
    console.error("ended-listings error:", e.message);
    // Fall back to local file if eBay query fails
    try {
      const store = loadEndedListings();
      res.json(Object.values(store).sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt)));
    } catch(e2) {
      res.status(500).json({ error: e.message });
    }
  }
});


// ── POST manually relist a single ended listing ───────────────────────────────
app.post("/api/ebay/relist", auth, async (req, res) => {
  const { sku, itemId } = req.body;
  if (!sku) return res.status(400).json({ error: "sku required" });

  // Always prefer live eBay data when itemId available — local file may be stale
  let entry = null;

  if (itemId) {
    try {
      const xml = create({ version: "1.0", encoding: "utf-8" })
        .ele("GetItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
          .ele("RequesterCredentials")
            .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
          .up()
          .ele("ItemID").txt(String(itemId)).up()
          .ele("DetailLevel").txt("ReturnAll").up()
        .up()
        .end({ prettyPrint: false });

      const ebayRes = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("GetItem"), body: xml });
      const parsed = await parseXml(await ebayRes.text());
      const item = parsed?.GetItemResponse?.Item;

      if (item) {
        const specs = [].concat(item.ItemSpecifics?.NameValueList || []);
        const rawMaj = item.ShippingPackageDetails?.WeightMajor;
        const rawMin = item.ShippingPackageDetails?.WeightMinor;
        const wMaj = parseInt((typeof rawMaj === "object" ? rawMaj?._ || "0" : rawMaj) || "0");
        const wMin = parseInt((typeof rawMin === "object" ? rawMin?._ || "0" : rawMin) || "0");
        let weightLbs = wMaj > 0 ? wMaj + wMin / 16 : null;
        if (!weightLbs && WEIGHT_LOOKUP[sku]) weightLbs = WEIGHT_LOOKUP[sku];
        if (!weightLbs) { const m = (item.Title||"").match(/(\d+(?:\.\d+)?)\s*lb/i); if (m) weightLbs = parseFloat(m[1]); }

        // Helper to unwrap xml2js objects to plain string
        const unwrap = v => v == null ? "" : typeof v === "object" ? (v?._ || v?.["$t"] || Object.values(v)[0] || "") : String(v);

        entry = {
          sku,
          itemId,
          title: unwrap(item.Title) || sku,
          ebayPrice: parseFloat(unwrap(item.BuyItNowPrice) || unwrap(item.StartPrice) || "0") || 0,
          quantity: parseInt(unwrap(item.Quantity) || "5") || 5,
          brand: specs.find(s => unwrap(s.Name) === "Brand") ? unwrap(specs.find(s => unwrap(s.Name) === "Brand").Value) : "Unbranded",
          itemType: specs.find(s => unwrap(s.Name) === "Type") ? unwrap(specs.find(s => unwrap(s.Name) === "Type").Value) : "",
          weightLbs: weightLbs || 1,
          imageUrl: unwrap([].concat(item.PictureDetails?.PictureURL || [])[0]) || "",
          description: unwrap(item.Description) || "",
          categoryId: unwrap(item.PrimaryCategory?.CategoryID) || "79631",
          conditionId: unwrap(item.ConditionID) || "1000",
        };

        console.log(`Relist entry built — title:"${entry.title}" price:${entry.ebayPrice} weight:${entry.weightLbs}`);
      }
    } catch(e) {
      console.error("GetItem for relist failed:", e.message);
    }
  }

  // Fall back to local file only if live eBay fetch failed
  if (!entry) {
    const localEntry = loadEndedListings()[sku];
    if (localEntry && localEntry.title && localEntry.ebayPrice) {
      entry = localEntry;
      console.log(`Relist using local file fallback for SKU ${sku}`);
    }
  }

  if (!entry) return res.status(404).json({ error: "No ended listing found for SKU: " + sku });

  try {
    const newItemId = await relistOnEbay(entry);
    removeEndedListing(sku);
    res.json({ success: true, itemId: newItemId });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});


// ── POST manually trigger auto-relist check ───────────────────────────────────
app.post("/api/sync-relist", auth, async (req, res) => {
  try {
    await checkAndRelistFromSquare();
    res.json({ success: true, message: "Relist check complete" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual sync endpoint (hit from dashboard) ────────────────────────────────
app.post("/api/sync-orders", auth, async (req, res) => {
  try {
    await syncLatestEbayOrders();
    res.json({ success: true, message: "Sync complete" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual not-for-sale check (hit from dashboard) ───────────────────────────
app.post("/api/sync-sellability", auth, async (req, res) => {
  try {
    await removeUnsellableFromEbay();
    res.json({ success: true, message: "Sellability check complete" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Create Square order from eBay order data ─────────────────────────────────
async function createSquareOrderFromEbay(ebayOrder) {
  try {
    const orderId = ebayOrder.OrderID;
    const buyer = ebayOrder.BuyerUserID || "eBay Buyer";
    const transactions = [].concat(ebayOrder.TransactionArray?.Transaction || []);

    // Get Square location
    const locRes = await fetch(`${SQUARE_BASE}/v2/locations`, { headers: squareHeaders() });
    const locData = await locRes.json();
    const locationId = locData.locations?.[0]?.id;
    if (!locationId) throw new Error("No Square location found");

    const lineItems = transactions.map((t) => {
      const itemTitle = t.Item?.Title || "eBay Item";
      const qty = parseInt(t.QuantityPurchased || "1");
      const price = parseFloat(t.TransactionPrice?.["_"] || t.TransactionPrice || "0");
      return {
        name: itemTitle.substring(0, 500),
        quantity: String(qty),
        base_price_money: {
          amount: Math.round(price * 100),
          currency: "USD",
        },
        note: `eBay SKU: ${t.Item?.SKU || "N/A"} | eBay Order: ${orderId}`,
      };
    });

    if (!lineItems.length) return;

    const shippingAddress = ebayOrder.ShippingAddress || {};
    const fulfillment = {
      type: "SHIPMENT",
      state: "PROPOSED",
      shipment_details: {
        recipient: {
          display_name: shippingAddress.Name || buyer,
          address: {
            address_line_1: shippingAddress.Street1 || "",
            address_line_2: shippingAddress.Street2 || "",
            locality: shippingAddress.CityName || "",
            administrative_district_level_1: shippingAddress.StateOrProvince || "",
            postal_code: shippingAddress.PostalCode || "",
            country: shippingAddress.Country || "US",
          },
        },
      },
    };

    const orderBody = {
      idempotency_key: `ebay-${orderId}-${Date.now()}`,
      order: {
        location_id: locationId,
        line_items: lineItems,
        fulfillments: [fulfillment],
        metadata: {
          source: "eBay",
          ebay_order_id: orderId,
          ebay_buyer: buyer,
        },
      },
    };

    const sqRes = await fetch(`${SQUARE_BASE}/v2/orders`, {
      method: "POST",
      headers: squareHeaders(),
      body: JSON.stringify(orderBody),
    });

    const sqData = await sqRes.json();
    if (!sqRes.ok) {
      console.error("Square order creation failed:", sqData.errors?.[0]?.detail);
    } else {
      console.log(`✓ Square order created for eBay order ${orderId}: ${sqData.order?.id}`);
    }
  } catch (e) {
    console.error("createSquareOrderFromEbay error:", e.message);
  }
}

// ── eBay Marketplace Account Deletion Compliance ─────────────────────────────
// eBay requires this endpoint to be registered in the developer portal.
// It handles two things:
//   1. GET  — eBay sends a challenge_code to verify you own the endpoint.
//             We hash it and send it back so eBay unlocks your keyset.
//   2. POST — eBay notifies you when a buyer closes their account.
//             We just log it (no buyer PII is stored in this app).

const crypto = require("crypto");

app.get("/webhook/ebay-account-deletion", (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) {
    return res.status(400).json({ error: "Missing challenge_code" });
  }

  // eBay requires: SHA-256(challengeCode + verificationToken + endpoint URL)
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN || "ebay-deletion-token";
  const endpointUrl = process.env.EBAY_DELETION_ENDPOINT_URL || "";

  const hash = crypto
    .createHash("sha256")
    .update(challengeCode + verificationToken + endpointUrl)
    .digest("hex");

  // Must respond with exactly this JSON structure
  res.json({ challengeResponse: hash });
});

app.post("/webhook/ebay-account-deletion", (req, res) => {
  // A buyer has closed their eBay account.
  // This app doesn't store buyer PII, so nothing to delete — just acknowledge.
  console.log("eBay account deletion notification received:", JSON.stringify(req.body).substring(0, 200));
  res.status(200).json({ message: "Acknowledged" });
});

// ── Claude: auto-fill category, brand, type, weight ─────────────────────────
app.post("/api/claude/autofill", auth, async (req, res) => {
  const { name, description, weight } = req.body;

  const prompt = "You are an eBay listing expert for a grain mill and whole foods store. Given a product name and description, return ONLY a JSON object with these fields:\n- categoryId: the best eBay US category ID (number as string)\n- brand: brand name from the product (or Unbranded)\n- type: short product type for eBay item specifics\n- weight: weight in lbs as a number (use provided weight, or extract from name, or null)\n- categoryName: human readable category name\n- categoryRationale: one short sentence explaining why this category was chosen (e.g. \"Matches Grains & Rice — whole unground wheat kernel product\")\n\nProduct name: " + name + "\nDescription: " + (description || "None") + "\nKnown weight (lbs): " + (weight || "unknown") + "\n\nCategory IDs to use:\nALWAYS use categoryId: \"14308\" (Food & Beverages) for ALL food, grain, flour, spice, oil, honey, baking, and beverage products. Only use 20626 for Food Storage equipment, 184638 for Grain Mills, 133696 for Food Dehydrators, 79631 for anything that truly does not fit food categories.\n\nReturn ONLY valid JSON, no markdown, no explanation.";

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claude: optimize eBay title for max keyword reach ───────────────────────
app.post("/api/claude/optimize-title", auth, async (req, res) => {
  const { name, description, category, weight } = req.body;

  const prompt = `You are an eBay SEO expert specializing in bulk food, grains, and baking supplies. Your job is to write eBay listing titles that maximize search visibility.

eBay titles have a hard limit of 80 characters. The best titles:
- Lead with the most-searched keyword (product type first, not brand)
- Include weight/quantity when relevant (buyers search "5 lb", "50 lb", etc.)
- Include key attributes: grain variety, grind type, certifications (Non-GMO, Organic, Gluten Free)
- Include common buyer terms: Bulk, Whole, Fresh, Baking, Food Storage, etc.
- Avoid filler words: "Great", "Best", "Amazing", "Quality"
- Never truncate mid-word — stay at or under 80 characters exactly

Product name: ${name}
Description: ${description || "None"}
Category: ${category || "Unknown"}
Weight: ${weight ? weight + " lbs" : "unknown"}

Return ONLY a JSON object with this exact structure — no markdown, no explanation:
{
  "titles": [
    { "title": "...", "chars": 0, "rationale": "one sentence explaining keyword strategy" },
    { "title": "...", "chars": 0, "rationale": "one sentence explaining keyword strategy" }
  ]
}

Each title must be 70-80 characters. Count carefully. The "chars" field must be the exact character count of the title string.`;

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    // Recount chars server-side to catch model miscounts
    parsed.titles = (parsed.titles || []).map(t => ({
      ...t,
      chars: t.title.length
    }));
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claude: generate branded eBay HTML description ──────────────────────────
const LOGO_URL = "https://ee7bbb4445cd029653d2.cdn6.editmysite.com/uploads/b/ee7bbb4445cd029653d297c0f017675bcd272f2f5d280a31073c8a04e963b02e/logo-no-bg-1_1779714609.png";

// ── Shared: generate branded HTML description for a product ─────────────────
async function generateBrandedDescription({ name, description, sku, weight, imageUrl }) {
  const prompt = `You are writing eBay listing copy for The Grain Mill Co-op, a bulk grain and baking supplies store in Wake Forest, NC that ships from Dutch Amish Country, PA.

Given the product info below, return ONLY a JSON object with two fields:
- "about": 2-3 sentence compelling product description for eBay buyers (plain text, no HTML)
- "ingredients": ingredients list as plain text (e.g. "100% Hard Red Wheat Kernels. No additives, no preservatives." — if this is not a food item with ingredients, return an empty string)

Be specific to the product. Mention use cases (baking, grinding, food storage, etc.) where relevant. Keep it factual and helpful. Do not mention any website or external links.

Product name: ${name}
Existing description: ${description || "None"}
Weight: ${weight ? weight + " lbs" : "unknown"}
SKU: ${sku || "unknown"}

Return ONLY valid JSON, no markdown, no explanation.`;

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const claudeData = await claudeRes.json();
  const text = claudeData.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  const { about, ingredients } = JSON.parse(clean);

  const weightDisplay = weight ? weight + " lb" : "—";
  const imgTag = imageUrl
    ? `<img src="${imageUrl}" alt="${name}" style="width:100%;border-radius:6px;border:0.5px solid #d4c4a0;display:block;min-height:80px;" />`
    : `<div style="width:100%;min-height:140px;background:#f9f6ef;border-radius:6px;border:0.5px solid #d4c4a0;"></div>`;

  const ingredientsSection = ingredients
    ? `<div style="border-top:0.5px solid #d4c4a0;padding-top:18px;margin-bottom:18px;">
    <div style="font-size:14px;font-weight:500;color:#3a2e1a;margin-bottom:8px;">Ingredients</div>
    <div style="font-size:14px;color:#5a4a2a;line-height:1.7;font-family:sans-serif;">${ingredients}</div>
  </div>`
    : "";

  const html = `<div style="background:#fff;border-radius:8px;border:0.5px solid #d4c4a0;overflow:hidden;max-width:640px;margin:0 auto;font-family:Georgia,serif;">
  <div style="background:#9b804a;padding:16px 24px;display:flex;align-items:center;gap:16px;">
    <img src="${LOGO_URL}" alt="The Grain Mill Co-op" style="height:60px;width:auto;display:block;" />
    <div style="border-left:0.5px solid #c4a46a;padding-left:16px;">
      <div style="color:#f2ede3;font-size:13px;font-family:sans-serif;">Bulk Grains &#38; Baking Supplies</div>
      <div style="color:#d4c4a0;font-size:12px;margin-top:4px;font-family:sans-serif;">Ships UPS Ground from Dutch Amish Country, PA</div>
    </div>
  </div>
  <div style="padding:24px;">
    <div style="display:grid;grid-template-columns:180px 1fr;gap:20px;margin-bottom:24px;align-items:start;">
      <div>${imgTag}</div>
      <div>
        <div style="font-size:17px;font-weight:500;color:#3a2e1a;margin-bottom:4px;line-height:1.3;">${name}</div>
        <div style="font-size:13px;color:#9b804a;font-family:sans-serif;margin-bottom:14px;">SKU: ${sku || "—"}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="background:#f9f6ef;border:0.5px solid #d4c4a0;border-radius:6px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#9b804a;font-family:sans-serif;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Weight</div>
            <div style="font-size:15px;font-weight:500;color:#3a2e1a;font-family:sans-serif;">${weightDisplay}</div>
          </div>
          <div style="background:#f9f6ef;border:0.5px solid #d4c4a0;border-radius:6px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#9b804a;font-family:sans-serif;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Condition</div>
            <div style="font-size:15px;font-weight:500;color:#3a2e1a;font-family:sans-serif;">New</div>
          </div>
        </div>
      </div>
    </div>
    <div style="border-top:0.5px solid #d4c4a0;padding-top:18px;margin-bottom:18px;">
      <div style="font-size:14px;font-weight:500;color:#3a2e1a;margin-bottom:8px;">About this item</div>
      <div style="font-size:14px;color:#5a4a2a;line-height:1.7;font-family:sans-serif;">${about}</div>
    </div>
    ${ingredientsSection}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;border-top:0.5px solid #d4c4a0;padding-top:18px;">
      <div>
        <div style="font-size:14px;font-weight:500;color:#3a2e1a;margin-bottom:8px;">Shipping</div>
        <div style="font-size:13px;color:#5a4a2a;line-height:1.7;font-family:sans-serif;">Ships UPS Ground from Dutch Amish Country, PA. Orders typically ship within 2–3 business days. Calculated shipping to your location at checkout.</div>
      </div>
      <div>
        <div style="font-size:14px;font-weight:500;color:#3a2e1a;margin-bottom:8px;">Returns</div>
        <div style="font-size:13px;color:#5a4a2a;line-height:1.7;font-family:sans-serif;">All sales final once parcel is opened. Unopened items may be refused at delivery. Quality issues? Contact us within 14 days for an RMA and return label.</div>
      </div>
    </div>
  </div>
  <div style="background:#9b804a;padding:13px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
    <span style="color:#f2ede3;font-size:12px;font-family:sans-serif;">The Grain Mill Co-op &#183; 230 S Main St, Wake Forest, NC 27587</span>
    <span style="color:#d4c4a0;font-size:12px;font-family:sans-serif;">Bulk grains, flours &#38; baking supplies</span>
  </div>
</div>`;

  // Sanitize: replace all named HTML entities with numeric equivalents
  // eBay's XML parser only accepts numeric character references
  const NAMED_ENTITIES = {
    '&amp;': '&#38;', '&lt;': '&#60;', '&gt;': '&#62;', '&quot;': '&#34;',
    '&apos;': '&#39;', '&nbsp;': '&#160;', '&middot;': '&#183;',
    '&mdash;': '&#8212;', '&ndash;': '&#8211;', '&bull;': '&#8226;',
    '&hellip;': '&#8230;', '&trade;': '&#8482;', '&reg;': '&#174;',
    '&copy;': '&#169;', '&laquo;': '&#171;', '&raquo;': '&#187;',
    '&ldquo;': '&#8220;', '&rdquo;': '&#8221;', '&lsquo;': '&#8216;',
    '&rsquo;': '&#8217;', '&frac12;': '&#189;', '&frac14;': '&#188;',
    '&frac34;': '&#190;', '&deg;': '&#176;', '&plusmn;': '&#177;',
    '&times;': '&#215;', '&divide;': '&#247;', '&euro;': '&#8364;',
    '&pound;': '&#163;', '&yen;': '&#165;', '&cent;': '&#162;',
    '&acute;': '&#180;', '&uml;': '&#168;', '&cedil;': '&#184;',
  };
  const sanitizedHtml = html.replace(/&[a-zA-Z]+;/g, match =>
    NAMED_ENTITIES[match] || match.replace(/&([a-zA-Z]+);/, (_, name) => {
      // Any unknown named entity: strip it to avoid XML parse errors
      console.warn(`Unknown HTML entity stripped: ${match}`);
      return '';
    })
  );

  // Strip any JS event handler attributes eBay blocks (on*, javascript:)
  const noJsHtml = sanitizedHtml
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript\s*:/gi, '');

  return { html: noJsHtml, about, ingredients };
}

// ── Pre-create all Store categories in one batch ─────────────────────────────
// SetStoreCategories has a daily limit — call it once with all needed names
// rather than once per listing. Called at start of bulk revise.
async function ensureAllStoreCategories() {
  // Load existing categories first
  if (storeCategoryCache === null) {
    try { await loadStoreCategoryCache(); } catch(e) {
      console.error("Failed to load Store category cache:", e.message);
      storeCategoryCache = {};
    }
  }

  // Find which Store category names we need that don't exist yet
  const allNames = [...new Set(Object.values(EBAY_TO_STORE_CATEGORY))];
  const missing = allNames.filter(name => !storeCategoryCache[name]);

  if (!missing.length) {
    console.log(`All ${allNames.length} Store categories already exist`);
    return;
  }

  console.log(`Creating ${missing.length} missing Store categories: ${missing.join(", ")}`);

  // eBay allows up to 10 categories per SetStoreCategories call — batch them
  const BATCH_SIZE = 10;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    try {
      let reqNode = create({ version: "1.0", encoding: "utf-8" })
        .ele("SetStoreCategoriesRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
          .ele("RequesterCredentials")
            .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
          .up()
          .ele("Action").txt("Add").up()
          .ele("StoreCategories");

      batch.forEach((name, idx) => {
        reqNode = reqNode
          .ele("CustomCategory")
            .ele("CategoryID").txt("-1").up()
            .ele("Name").txt(name).up()
            .ele("Order").txt(String(900 + i + idx)).up()
          .up();
      });

      const xml = reqNode.up().up().end({ prettyPrint: false });
      const res = await fetch(EBAY_API_URL, {
        method: "POST",
        headers: ebayHeaders("SetStoreCategories"),
        body: xml,
      });
      const parsed = await parseXml(await res.text());
      const resp = parsed?.SetStoreCategoriesResponse;

      if (resp?.Ack === "Failure") {
        const errors = [].concat(resp?.Errors || []).map(e => e.ShortMessage).join("; ");
        console.error(`SetStoreCategories batch failed: ${errors}`);
      } else {
        console.log(`✓ Batch created Store categories: ${batch.join(", ")}`);
      }

      // Small delay between batches
      if (i + BATCH_SIZE < missing.length) await new Promise(r => setTimeout(r, 1000));
    } catch(e) {
      console.error(`ensureAllStoreCategories batch error: ${e.message}`);
    }
  }

  // Reload cache to pick up all new IDs
  await loadStoreCategoryCache().catch(() => {});
}


// Applied during bulk revise to fix miscategorized listings automatically.
const CATEGORY_CORRECTIONS = {
  // Redirect all old/wrong subcategory IDs to Food & Beverages (14308)
  "257947": "14308", "257954": "14308", "14923": "14308",
  "14308": "14308", "257993": "14308", "257990": "14308",
  "257949": "14308", "257952": "14308", "257951": "14308",
  "257958": "14308", "257989": "14308", "257988": "14308",
  "257977": "14308", "257979": "14308", "257978": "14308",
  "257975": "14308", "257983": "14308", "257984": "14308",
  "257985": "14308", "257982": "14308", "257991": "14308",
  "258012": "14308", "258013": "14308", "257995": "14308",
  "257971": "14308", "257943": "14308", "257942": "14308",
};

// For each active listing: regenerates branded description via Claude,
// resolves/creates Store category, and pushes ReviseFixedPriceItem to eBay.
// Uses SSE so the dashboard can stream live progress.
app.get("/api/ebay/bulk-revise", auth, async (req, res) => {
  // Set up Server-Sent Events so the UI gets live progress
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    // 1. Fetch all active listings (paginate)
    send({ type: "status", message: "Fetching active eBay listings…" });
    const allItems = [];
    for (let page = 1; page <= 20; page++) {
      const xml = create({ version: "1.0", encoding: "utf-8" })
        .ele("GetMyeBaySellingRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
          .ele("RequesterCredentials")
            .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
          .up()
          .ele("ActiveList")
            .ele("Include").txt("true").up()
            .ele("Pagination")
              .ele("EntriesPerPage").txt("50").up()
              .ele("PageNumber").txt(String(page)).up()
            .up()
          .up()
          .ele("DetailLevel").txt("ReturnAll").up()
        .up()
        .end({ prettyPrint: false });

      const ebayRes = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("GetMyeBaySelling"), body: xml });
      const parsed = await parseXml(await ebayRes.text());
      const resp = parsed?.GetMyeBaySellingResponse;
      const items = [].concat(resp?.ActiveList?.ItemArray?.Item || []);
      allItems.push(...items);
      const totalPages = parseInt(resp?.ActiveList?.PaginationResult?.TotalNumberOfPages || "1");
      if (page >= totalPages) break;
    }

    const total = allItems.length;
    send({ type: "status", message: `Found ${total} active listings. Building category map…`, total });

    // Pre-build SKU → Square department name map from the full catalog
    // This avoids 3 Square API calls per item during the loop
    const skuToCategoryName = {};
    try {
      // Fetch all Square items with their categories in one pass
      let cursor = null;
      const squareCatHierarchy = {};
      do {
        const sqRes = await fetch(`${SQUARE_BASE}/v2/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ''}`, {
          headers: squareHeaders()
        });
        const sqData = await sqRes.json();
        const objects = sqData.objects || [];
        objects.forEach(obj => {
          const catId = obj.item_data?.category_id
            || (obj.item_data?.categories || [])[0]?.id
            || null;
          if (catId) {
            (obj.item_data?.variations || []).forEach(v => {
              const sku = v.item_variation_data?.sku;
              if (sku) squareCatHierarchy[sku] = catId;
            });
          }
        });
        cursor = sqData.cursor || null;
      } while (cursor);

      // Fetch all category objects to resolve hierarchy
      const allCatIds = [...new Set(Object.values(squareCatHierarchy))];
      const catMap = {};
      for (let i = 0; i < allCatIds.length; i += 100) {
        const batch = allCatIds.slice(i, i + 100);
        const catRes = await fetch(`${SQUARE_BASE}/v2/catalog/batch-retrieve`, {
          method: "POST", headers: squareHeaders(),
          body: JSON.stringify({ object_ids: batch })
        });
        const catData = await catRes.json();
        (catData.objects || []).forEach(c => {
          catMap[c.id] = { name: c.category_data?.name || "", parentId: c.category_data?.parent_category?.id || null };
        });
      }
      // Fetch parent categories (up to 5 rounds)
      let toFetch = [...new Set(Object.values(catMap).map(c => c.parentId).filter(Boolean).filter(id => !catMap[id]))];
      for (let round = 0; round < 5 && toFetch.length; round++) {
        const pRes = await fetch(`${SQUARE_BASE}/v2/catalog/batch-retrieve`, {
          method: "POST", headers: squareHeaders(),
          body: JSON.stringify({ object_ids: toFetch })
        });
        const pData = await pRes.json();
        const nextFetch = [];
        (pData.objects || []).forEach(c => {
          const gpId = c.category_data?.parent_category?.id || null;
          catMap[c.id] = { name: c.category_data?.name || "", parentId: gpId };
          if (gpId && !catMap[gpId] && !nextFetch.includes(gpId)) nextFetch.push(gpId);
        });
        toFetch = nextFetch;
      }

      // Resolve each SKU to its department name
      const isAlphaGroup = (name) => /^[A-Z][a-z]{0,2}(-[A-Z][a-z]{0,2})?$/.test(name.trim());
      const resolve = (catId) => {
        const chain = [];
        let cur = catId;
        const seen = new Set();
        while (cur && catMap[cur] && !seen.has(cur)) {
          seen.add(cur);
          chain.push(catMap[cur].name);
          cur = catMap[cur].parentId;
        }
        const filtered = chain.filter(n => n && !isAlphaGroup(n)).reverse();
        return filtered[0] || chain[0] || "";
      };

      Object.entries(squareCatHierarchy).forEach(([sku, catId]) => {
        skuToCategoryName[sku] = resolve(catId);
      });

      console.log(`Category map built: ${Object.keys(skuToCategoryName).length} SKUs mapped`);
    } catch(e) {
      console.error("Failed to build SKU category map:", e.message);
    }

    send({ type: "status", message: `Found ${total} active listings. Starting revise…`, total });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      const itemId = item.ItemID;
      const title = item.Title || "";
      const sku = item.SKU || "";

      send({ type: "progress", index: i + 1, total, itemId, title, sku, status: "working" });

      try {
        // 2. Fetch full item details (need image, weight, category, existing desc)
        const getXml = create({ version: "1.0", encoding: "utf-8" })
          .ele("GetItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
            .ele("RequesterCredentials")
              .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
            .up()
            .ele("ItemID").txt(String(itemId)).up()
            .ele("DetailLevel").txt("ReturnAll").up()
          .up()
          .end({ prettyPrint: false });

        const getRes = await fetch(EBAY_API_URL, { method: "POST", headers: ebayHeaders("GetItem"), body: getXml });
        const getParsed = await parseXml(await getRes.text());
        const fullItem = getParsed?.GetItemResponse?.Item;

        const rawCategoryId = String(fullItem?.PrimaryCategory?.CategoryID || "");
        // Auto-correct known wrong category IDs
        const categoryId = CATEGORY_CORRECTIONS[rawCategoryId] || rawCategoryId;
        if (CATEGORY_CORRECTIONS[rawCategoryId]) {
          console.log(`[${itemId}] Category corrected: ${rawCategoryId} → ${categoryId} (${title})`);
        }
        const imageUrl = [].concat(fullItem?.PictureDetails?.PictureURL || [])[0] || "";

        // Safely extract weight — WeightMajor/Minor may be objects from xml2js
        const rawMajor = fullItem?.ShippingPackageDetails?.WeightMajor;
        const rawMinor = fullItem?.ShippingPackageDetails?.WeightMinor;
        const weightMajor = parseInt((typeof rawMajor === "object" ? rawMajor?._ || rawMajor?.["$t"] || "0" : rawMajor) || "0");
        const weightMinor = parseInt((typeof rawMinor === "object" ? rawMinor?._ || rawMinor?.["$t"] || "0" : rawMinor) || "0");
        let weightLbs = weightMajor > 0 ? weightMajor + weightMinor / 16 : null;

        // Fallback: check weight lookup table by SKU
        if (!weightLbs && sku && WEIGHT_LOOKUP[sku]) {
          weightLbs = WEIGHT_LOOKUP[sku];
        }

        // Last resort: try to parse weight from the title (e.g. "25lb", "5 lbs", "50 lb")
        if (!weightLbs && title) {
          const wMatch = title.match(/(\d+(?:\.\d+)?)\s*lb/i);
          if (wMatch) weightLbs = parseFloat(wMatch[1]);
        }

        const existingDesc = fullItem?.Description || "";

        // 3. Generate branded description via Claude
        const { html } = await generateBrandedDescription({
          name: title,
          description: existingDesc,
          sku,
          weight: weightLbs,
          imageUrl,
        });

        // 4. Resolve Store category from pre-built SKU map
        const squareCategoryName = skuToCategoryName[sku] || null;
        const storeCatId = squareCategoryName ? await getOrCreateStoreCategory(squareCategoryName).catch(() => null) : null;

        // 5. Build ReviseFixedPriceItem XML
        let reviseNode = create({ version: "1.0", encoding: "utf-8" })
          .ele("ReviseFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
            .ele("RequesterCredentials")
              .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
            .up()
            .ele("Item")
              .ele("ItemID").txt(String(itemId)).up()
              .ele("Description").txt(html).up();

        if (storeCatId) {
          reviseNode = reviseNode
            .ele("Storefront")
              .ele("StoreCategoryID").txt(String(storeCatId)).up()
            .up();
        }

        const reviseXml = reviseNode.up().up().end({ prettyPrint: false });

        const reviseRes = await fetch(EBAY_API_URL, {
          method: "POST",
          headers: ebayHeaders("ReviseFixedPriceItem"),
          body: reviseXml,
        });
        const reviseParsed = await parseXml(await reviseRes.text());
        const reviseResp = reviseParsed?.ReviseFixedPriceItemResponse;

        if (reviseResp?.Ack === "Failure") {
          const errors = [].concat(reviseResp?.Errors || []).filter(e => e.SeverityCode === "Error" || !e.SeverityCode);
          const msg = errors.map(e => e.ShortMessage).join("; ");
          send({ type: "progress", index: i + 1, total, itemId, title, sku, status: "error", message: msg });
          failed++;
        } else {
          // Warning = success — log but don't fail
          const warnings = [].concat(reviseResp?.Errors || []).filter(e => e.SeverityCode === "Warning");
          if (warnings.length) console.log(`[${itemId}] warnings: ${warnings.map(w => w.ShortMessage).join("; ")}`);
          send({ type: "progress", index: i + 1, total, itemId, title, sku, status: "done",
            storeCat: storeCatId || null });
          succeeded++;
        }
      } catch(e) {
        send({ type: "progress", index: i + 1, total, itemId, title, sku, status: "error", message: e.message });
        failed++;
      }

      // 500ms delay between items to respect eBay rate limits
      if (i < allItems.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    send({ type: "done", total, succeeded, failed });
  } catch(e) {
    send({ type: "error", message: e.message });
  } finally {
    res.end();
  }
});

// ── Claude: generate branded eBay HTML description (single item) ─────────────
app.post("/api/claude/generate-description", auth, async (req, res) => {
  const { name, description, sku, weight, imageUrl } = req.body;
  try {
    const result = await generateBrandedDescription({ name, description, sku, weight, imageUrl });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: preview values without sending to eBay ────────────────────────────
app.post("/api/ebay/preview-xml", auth, async (req, res) => {
  const { name, ebayPrice, quantity, categoryId, conditionId, markup, imageUrl, brand, itemType, weightLbs } = req.body;
  const finalPrice = markup !== undefined ? parseFloat((ebayPrice * (1 + parseFloat(markup) / 100)).toFixed(2)) : ebayPrice;
  const totalOz = Math.round(parseFloat(weightLbs) * 16);
  const weightPounds = Math.floor(totalOz / 16);
  const weightOunces = totalOz % 16;
  const noConditionCategories = ["14308", "14308", "181000", "3025"];
  const skipCondition = noConditionCategories.includes(String(categoryId));
  res.json({ debug: { weightLbs, totalOz, weightPounds, weightOunces, skipCondition, categoryId, finalPrice, brand, itemType, hasImage: !!imageUrl } });
});

// ── eBay: get active listings ─────────────────────────────────────────────────
app.get("/api/ebay/listings", auth, async (req, res) => {
  const page = parseInt(req.query.page || "1");
  const xml = create({ version: "1.0", encoding: "utf-8" })
    .ele("GetMyeBaySellingRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("ActiveList")
        .ele("Include").txt("true").up()
        .ele("Pagination")
          .ele("EntriesPerPage").txt("50").up()
          .ele("PageNumber").txt(String(page)).up()
        .up()
        .ele("Sort").txt("TimeLeft").up()
      .up()
      .ele("DetailLevel").txt("ReturnAll").up()
    .up()
    .end({ prettyPrint: false });

  try {
    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("GetMyeBaySelling"),
      body: xml,
    });
    const xmlText = await ebayRes.text();
    const parsed = await parseXml(xmlText);
    const resp = parsed?.GetMyeBaySellingResponse;

    if (resp?.Ack === "Failure") {
      const errors = [].concat(resp?.Errors || []);
      return res.status(400).json({ error: errors.map(e => e.LongMessage || e.ShortMessage).join("; ") });
    }

    const items = [].concat(resp?.ActiveList?.ItemArray?.Item || []);
    const totalPages = parseInt(resp?.ActiveList?.PaginationResult?.TotalNumberOfPages || "1");
    const totalItems = parseInt(resp?.ActiveList?.PaginationResult?.TotalNumberOfEntries || "0");

    const listings = items.map(item => ({
      itemId: item.ItemID,
      title: item.Title,
      sku: item.SKU || "",
      price: parseFloat(item.SellingStatus?.CurrentPrice?.["_"] || item.BuyItNowPrice?.["_"] || 0),
      quantity: parseInt(item.QuantityAvailable || item.Quantity || 1),
      url: `https://www.ebay.com/itm/${item.ItemID}`,
      timeLeft: item.TimeLeft || "",
      watchCount: parseInt(item.WatchCount || 0),
    }));

    res.json({ listings, totalPages, totalItems, page });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── eBay: check if SKUs are listed (also returns current eBay price) ─────────
// POST { skus: ["155009", "155010", ...] }
// Returns { "155009": { itemId: "123456", ebayPrice: 31.75 }, ... }
// ── Active listings cache — refreshed on demand, max once per 2 minutes ───────
let activeListingsCache = null;
let activeListingsCacheTime = 0;
const ACTIVE_CACHE_TTL = 2 * 60 * 1000;

async function getActiveListingsMap(force = false) {
  const now = Date.now();
  if (!force && activeListingsCache && (now - activeListingsCacheTime) < ACTIVE_CACHE_TTL) {
    return activeListingsCache;
  }
  const map = {};
  for (let page = 1; page <= 20; page++) {
    const xml = create({ version: "1.0", encoding: "utf-8" })
      .ele("GetMyeBaySellingRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
        .ele("RequesterCredentials")
          .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
        .up()
        .ele("ActiveList")
          .ele("Include").txt("true").up()
          .ele("Pagination")
            .ele("EntriesPerPage").txt("200").up()
            .ele("PageNumber").txt(String(page)).up()
          .up()
        .up()
        .ele("DetailLevel").txt("ReturnAll").up()
      .up()
      .end({ prettyPrint: false });

    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("GetMyeBaySelling"),
      body: xml,
    });
    const parsed = await parseXml(await ebayRes.text());
    const resp = parsed?.GetMyeBaySellingResponse;
    const items = [].concat(resp?.ActiveList?.ItemArray?.Item || []);
    items.forEach(item => {
      const sku = String(item.SKU || "");
      if (sku) {
        const price = parseFloat(
          item.SellingStatus?.CurrentPrice?._ ||
          item.BuyItNowPrice?._ ||
          item.StartPrice?._ || "0"
        );
        map[sku] = { itemId: item.ItemID, ebayPrice: price };
      }
    });
    const totalPages = parseInt(resp?.ActiveList?.PaginationResult?.TotalNumberOfPages || "1");
    if (page >= totalPages || !items.length) break;
  }
  activeListingsCache = map;
  activeListingsCacheTime = Date.now();
  console.log(`Active listings cache refreshed — ${Object.keys(map).length} SKUs`);
  return map;
}

app.post("/api/ebay/check-listed", auth, async (req, res) => {
  const { skus, force } = req.body;
  if (!skus || !skus.length) return res.json({});
  try {
    const map = await getActiveListingsMap(force === true);
    const result = {};
    skus.forEach(s => { result[String(s)] = map[String(s)] || null; });
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── eBay: sync price for a single listing ────────────────────────────────────
// POST { itemId, newPrice }
app.post("/api/ebay/sync-price", auth, async (req, res) => {
  const { itemId, newPrice } = req.body;
  if (!itemId || !newPrice) return res.status(400).json({ error: "itemId and newPrice required" });

  const xml = create({ version: "1.0", encoding: "utf-8" })
    .ele("ReviseFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("Item")
        .ele("ItemID").txt(String(itemId)).up()
        .ele("StartPrice").txt(String(parseFloat(newPrice).toFixed(2))).up()
      .up()
    .up()
    .end({ prettyPrint: false });

  try {
    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("ReviseFixedPriceItem"),
      body: xml,
    });
    const parsed = await parseXml(await ebayRes.text());
    const resp = parsed?.ReviseFixedPriceItemResponse;

    if (resp?.Ack === "Failure") {
      const errors = [].concat(resp?.Errors || []);
      return res.status(400).json({ error: errors.map(e => e.LongMessage || e.ShortMessage).join("; ") });
    }

    res.json({ success: true, itemId, newPrice: parseFloat(newPrice).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── eBay: end (remove) a listing ─────────────────────────────────────────────
app.post("/api/ebay/end-listing", auth, async (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: "itemId required" });

  const xml = create({ version: "1.0", encoding: "utf-8" })
    .ele("EndFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("ItemID").txt(String(itemId)).up()
      .ele("EndingReason").txt("NotAvailable").up()
    .up()
    .end({ prettyPrint: false });

  try {
    const ebayRes = await fetch(EBAY_API_URL, {
      method: "POST",
      headers: ebayHeaders("EndFixedPriceItem"),
      body: xml,
    });
    const parsed = await parseXml(await ebayRes.text());
    const resp = parsed?.EndFixedPriceItemResponse;

    if (resp?.Ack === "Failure") {
      const errors = [].concat(resp?.Errors || []);
      return res.status(400).json({ error: errors.map(e => e.LongMessage || e.ShortMessage).join("; ") });
    }

    activeListingsCache = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Approval Queue System ─────────────────────────────────────────────────────
// Queue items schema:
// { id, addedAt, status: 'processing'|'ready'|'approved'|'skipped'|'error',
//   product: { catalogId, variationId, name, description, sku, category,
//              squarePrice, ebayPrice, imageUrl, weight },
//   ai: { titles: [{title,chars,rationale}], selectedTitle, categoryId,
//         categoryName, categoryRationale, brand, type, descriptionHtml },
//   error: string|null }

const QUEUE_PATH = path.join(__dirname, "queue.json");

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); }
  catch(e) { return []; }
}

function saveQueue(q) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2), "utf8");
}

function queueUpdate(id, patch) {
  const q = loadQueue();
  const idx = q.findIndex(i => i.id === id);
  if (idx !== -1) { q[idx] = { ...q[idx], ...patch }; saveQueue(q); }
}

// Background: run AI pre-processing on a queue item
async function processQueueItem(id) {
  const q = loadQueue();
  const item = q.find(i => i.id === id);
  if (!item) return;

  try {
    const { name, description, sku, weight, imageUrl, category, ebayPrice } = item.product;

    // Run autofill + title optimization in parallel
    const [autofillData, titleData, descData] = await Promise.all([
      // Autofill: category, brand, type, rationale
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 300,
          messages: [{ role: "user", content:
            "You are an eBay listing expert for a grain mill and whole foods store. Return ONLY a JSON object:\n" +
            "- categoryId: best eBay US category ID (string)\n- brand: brand or Unbranded\n- type: short product type\n" +
            "- weight: weight in lbs as number or null\n- categoryName: human readable name\n" +
            "- categoryRationale: one short sentence explaining category choice\n\n" +
            "Product: " + name + "\nDescription: " + (description||"None") + "\nWeight: " + (weight||"unknown") + "\n\n" +
            "Category: ALWAYS use 14308 (Food & Beverages) for all food products. Only exceptions: 20626 for Food Storage equipment, 184638 for Grain Mills, 133696 for Food Dehydrators.\n" +
            "257952: Yeast, Leavening & Binders\n257951: Sugar & Sweeteners\n257944: Bread & Pastry Mixes\n" +
            "257945: Cake & Cupcake Mixes\n257946: Cookie & Brownie Mixes\n257989: Cooking Oils\n" +
            "257978: Salt\n257977: Pepper & Chili\n257980: Spices\n257979: Seasoning Mixes & Blends\n" +
            "257983: Honey\n257984: Jam, Jelly & Preserves\n257985: Nut Butters\n" +
            "257991: Dried Beans & Pulses\n257988: Longlife Cooking & Baking Fats\n" +
            "258012: Dried Fruit & Nuts\n258013: Popcorn\n257995: Prepared Food & Ready Meals\n" +
            "257971: Freeze-dried & Dehydrated Foods\n20626: Food Storage\n" +
            "184638: Grain Mills & Food Mills\n133696: Food Dehydrators\n79631: Other Food & Beverages\n\n" +
            "Return ONLY valid JSON, no markdown."
          }]
        })
      }).then(r => r.json()).then(d => JSON.parse((d.content?.[0]?.text||"{}").replace(/```json|```/g,"").trim())),

      // Title optimization
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 400,
          messages: [{ role: "user", content:
            "You are an eBay SEO expert for bulk food and grains. Write 2 eBay titles maximizing search visibility.\n" +
            "Rules: lead with most-searched keyword, include weight when relevant, include attributes (Non-GMO, Organic, Bulk, Whole), avoid filler words, 70-80 chars each.\n" +
            "Product: " + name + "\nDescription: " + (description||"None") + "\nWeight: " + (weight?weight+" lbs":"unknown") + "\n\n" +
            'Return ONLY JSON: {"titles":[{"title":"...","chars":0,"rationale":"..."},{"title":"...","chars":0,"rationale":"..."}]}'
          }]
        })
      }).then(r => r.json()).then(d => {
        const parsed = JSON.parse((d.content?.[0]?.text||"{}").replace(/```json|```/g,"").trim());
        parsed.titles = (parsed.titles||[]).map(t => ({ ...t, chars: t.title.length }));
        return parsed;
      }),

      // Description generation
      generateBrandedDescription({ name, description, sku, weight, imageUrl })
    ]);

    queueUpdate(id, {
      status: "ready",
      ai: {
        titles: titleData.titles || [],
        selectedTitle: (titleData.titles||[])[0]?.title || name.substring(0,80),
        categoryId: autofillData.categoryId || "79631",
        categoryName: autofillData.categoryName || "",
        categoryRationale: autofillData.categoryRationale || "",
        brand: autofillData.brand || "Unbranded",
        type: autofillData.type || "",
        weight: autofillData.weight || weight || null,
        descriptionHtml: descData.html || "",
      }
    });

    console.log(`✓ Queue item ${id} processed: ${name}`);
  } catch(e) {
    console.error(`Queue processing failed for ${id}:`, e.message);
    queueUpdate(id, { status: "error", error: e.message });
  }
}

// ── GET queue
app.get("/api/queue", auth, (req, res) => {
  res.json(loadQueue());
});

// ── GET queue stats
app.get("/api/queue/stats", auth, (req, res) => {
  const q = loadQueue();
  res.json({
    total: q.length,
    ready: q.filter(i => i.status === "ready").length,
    processing: q.filter(i => i.status === "processing").length,
    error: q.filter(i => i.status === "error").length,
  });
});

// ── POST add item to queue
app.post("/api/queue/add", auth, async (req, res) => {
  const { product } = req.body;
  if (!product || !product.sku) return res.status(400).json({ error: "product with sku required" });

  const q = loadQueue();

  // Prevent duplicates
  if (q.find(i => i.product.sku === product.sku && !["approved","skipped"].includes(i.status))) {
    return res.status(409).json({ error: "Item already in queue" });
  }

  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const item = {
    id, addedAt: new Date().toISOString(),
    status: "processing",
    product, ai: null, error: null
  };

  q.push(item);
  saveQueue(q);
  res.json({ id, status: "processing" });

  // Kick off background processing (non-blocking)
  processQueueItem(id).catch(e => console.error("processQueueItem error:", e.message));
});

// ── POST approve queue item — lists to eBay
app.post("/api/queue/approve", auth, async (req, res) => {
  const { id, selectedTitle, categoryId, brand, type, weight, price, quantity } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });

  const q = loadQueue();
  const item = q.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: "Queue item not found" });
  if (item.status !== "ready") return res.status(400).json({ error: "Item not ready" });

  const { product, ai } = item;
  const finalTitle = selectedTitle || ai.selectedTitle || product.name.substring(0,80);
  const finalCat = categoryId || ai.categoryId || "79631";
  const finalBrand = brand || ai.brand || "Unbranded";
  const finalType = type || ai.type || "";
  const finalWeight = parseFloat(weight || ai.weight || 1);
  const finalPrice = parseFloat(price || product.ebayPrice);
  const finalQty = parseInt(quantity || 5);

  try {
    // Resolve Store category from Square product category name
    const storeCatId = await getStoreCategoryId(product.category || "").catch(() => null);

    const totalOz = Math.round(finalWeight * 16);
    const weightPounds = Math.floor(totalOz / 16);
    const weightOunces = totalOz % 16;
    const noConditionCategories = ["14308","181000","3025"];
    const skipCondition = noConditionCategories.includes(String(finalCat));

    let itemNode = create({ version:"1.0", encoding:"utf-8" })
      .ele("AddFixedPriceItemRequest", { xmlns:"urn:ebay:apis:eBLBaseComponents" })
        .ele("RequesterCredentials").ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up().up()
        .ele("Item")
          .ele("Title").txt(finalTitle.substring(0,80)).up()
          .ele("Description").txt(ai.descriptionHtml || product.name).up()
          .ele("PrimaryCategory").ele("CategoryID").txt(String(finalCat)).up().up()
          .ele("StartPrice").txt(String(finalPrice)).up();

    if (!skipCondition) itemNode = itemNode.ele("ConditionID").txt("1000").up();
    if (storeCatId) itemNode = itemNode.ele("Storefront").ele("StoreCategoryID").txt(String(storeCatId)).up().up();

    itemNode = itemNode
      .ele("Country").txt("US").up()
      .ele("Currency").txt("USD").up()
      .ele("DispatchTimeMax").txt("3").up()
      .ele("ListingDuration").txt("GTC").up()
      .ele("ListingType").txt("FixedPriceItem").up()
      .ele("Quantity").txt(String(finalQty)).up()
      .ele("SKU").txt(product.sku || "").up();

    if (product.imageUrl) {
      itemNode = itemNode.ele("PictureDetails").ele("PictureURL").txt(product.imageUrl).up().up();
    }

    itemNode = itemNode
      .ele("ItemSpecifics")
        .ele("NameValueList").ele("Name").txt("Brand").up().ele("Value").txt(finalBrand).up().up()
        .ele("NameValueList").ele("Name").txt("Type").up().ele("Value").txt(finalType).up().up()
        .ele("NameValueList").ele("Name").txt("Product").up().ele("Value").txt(finalTitle.substring(0,65)).up().up()
      .up();

    const xml = (await buildPolicyXml(itemNode, { weightPounds, weightOunces, pkgDepth: 0, pkgWidth: 0, pkgHeight: 0 }))
      .up().up().end({ prettyPrint: false });

    const ebayRes = await fetch(EBAY_API_URL, { method:"POST", headers:ebayHeaders("AddFixedPriceItem"), body:xml });
    const parsed = await parseXml(await ebayRes.text());
    const resp = parsed?.AddFixedPriceItemResponse;

    if (resp?.Ack === "Failure" || resp?.Ack === "PartialFailure") {
      const errors = [].concat(resp?.Errors || []);
      const msg = errors.map(e => e.LongMessage || e.ShortMessage).join("; ");
      return res.status(400).json({ error: msg });
    }

    queueUpdate(id, { status: "approved", itemId: resp?.ItemID });
    activeListingsCache = null;
    res.json({ success: true, itemId: resp?.ItemID });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST skip queue item
app.post("/api/queue/skip", auth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  const q = loadQueue();
  const item = q.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: "not found" });
  // Move to end of queue with skipped status — can be re-added
  queueUpdate(id, { status: "skipped" });
  res.json({ success: true });
});

// ── DELETE remove item from queue
app.delete("/api/queue/:id", auth, (req, res) => {
  const q = loadQueue().filter(i => i.id !== req.params.id);
  saveQueue(q);
  res.json({ success: true });
});

// ── POST retry a failed queue item
app.post("/api/queue/retry", auth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  queueUpdate(id, { status: "processing", error: null, ai: null });
  res.json({ success: true });
  processQueueItem(id).catch(e => console.error("retry error:", e.message));
});

// ─────────────────────────────────────────────────────────────────────────────

// ── Global error handler — ensures every unhandled error returns JSON ─────────
app.use((err, req, res, next) => {
  console.error("Unhandled express error:", err.message, err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`eBay-Square bridge running on port ${PORT}`);
  // Pre-load seller profiles on boot so the raw API response appears in logs
  setTimeout(() => {
    getSellerProfiles().catch(e => console.error("Startup profile fetch error:", e.message));
  }, 3000);
});
