const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const xml2js = require("xml2js");
const { create } = require("xmlbuilder2");

// Load weight lookup table (SKU -> weight in lbs)
let WEIGHT_LOOKUP = {};
try {
  WEIGHT_LOOKUP = JSON.parse(fs.readFileSync(path.join(__dirname, "weight_lookup.json"), "utf8"));
  console.log(`Loaded ${Object.keys(WEIGHT_LOOKUP).length} SKU weights`);
} catch(e) {
  console.warn("weight_lookup.json not found");
}

const app = express();
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
  return xml2js.parseStringPromise(xmlStr, { explicitArray: false });
}

// ── Auth middleware for dashboard ────────────────────────────────────────────
function auth(req, res, next) {
  const pwd = req.headers["x-dashboard-password"];
  if (pwd !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Square: search catalog ───────────────────────────────────────────────────
app.get("/api/square/products", auth, async (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  if (!q || q.length < 2) return res.json([]);

  try {
    // Search catalog items
    const searchRes = await fetch(`${SQUARE_BASE}/v2/catalog/search`, {
      method: "POST",
      headers: squareHeaders(),
      body: JSON.stringify({
        object_types: ["ITEM"],
        query: {
          text_query: { keywords: [q] },
        },
        limit: 50,
      }),
    });
    const searchData = await searchRes.json();
    if (!searchRes.ok) {
      return res.status(searchRes.status).json({ error: searchData.errors?.[0]?.detail || "Search failed" });
    }

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

    const items = (searchData.objects || []).map((obj) => {
      const itemData = obj.item_data || {};
      const variation = (itemData.variations || [])[0];
      const variationData = variation?.item_variation_data || {};
      const priceAmount = variationData.price_money?.amount || 0;
      const priceDollars = priceAmount / 100;
      const ebayPrice = parseFloat((priceDollars * (1 + MARKUP)).toFixed(2));
      const imageId = itemImageMap[obj.id];

      return {
        catalogId: obj.id,
        variationId: variation?.id || null,
        name: itemData.name || "Unnamed",
        description: itemData.description || "",
        sku: variationData.sku || "",
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

  let itemNode = create({ version: "1.0", encoding: "utf-8" })
    .ele("AddFixedPriceItemRequest", { xmlns: "urn:ebay:apis:eBLBaseComponents" })
      .ele("RequesterCredentials")
        .ele("eBayAuthToken").txt(EBAY_USER_TOKEN).up()
      .up()
      .ele("Item")
        .ele("Title").txt(name.substring(0, 80)).up()
        .ele("Description").txt(description || name).up()
        .ele("PrimaryCategory")
          .ele("CategoryID").txt(String(categoryId || "177762")).up()
        .up()
        .ele("StartPrice").txt(String(finalPrice)).up();

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

  const xml = itemNode
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
        .ele("PayPalEmailAddress").txt(PAYPAL_EMAIL).up()
        .ele("Location").txt(process.env.SHIP_FROM_CITY || "Myerstown, PA").up()
        .ele("PostalCode").txt(process.env.SHIP_FROM_ZIP || "17067").up()
        .ele("Site").txt("US").up()
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
    .end();

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
      .end();

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
    }
  } catch (e) {
    console.error("syncLatestEbayOrders error:", e.message);
  }
}

// ── Manual sync endpoint (hit from dashboard) ────────────────────────────────
app.post("/api/sync-orders", auth, async (req, res) => {
  try {
    await syncLatestEbayOrders();
    res.json({ success: true, message: "Sync complete" });
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

  const prompt = "You are an eBay listing expert for a grain mill and whole foods store. Given a product name and description, return ONLY a JSON object with these fields:\n- categoryId: the best eBay US category ID (number as string)\n- brand: brand name from the product (or Unbranded)\n- type: short product type for eBay item specifics\n- weight: weight in lbs as a number (use provided weight, or extract from name, or null)\n- categoryName: human readable category name\n\nProduct name: " + name + "\nDescription: " + (description || "None") + "\nKnown weight (lbs): " + (weight || "unknown") + "\n\nCategory IDs to use:\n257993: Grains & Rice - whole unground grain kernels (wheat berries, corn, barley, millet, quinoa, rye, buckwheat, spelt berries)\n257947: Flour - already ground into flour (all-purpose, bread, wheat, spelt, rye, almond, coconut flour)\n257958: Breakfast Cereals & Oats - oats, oatmeal, granola, grits, farina, hot cereals\n257952: Yeast Leavening & Binders - yeast, baking powder, baking soda, cream of tartar, xanthan gum\n257951: Sugar & Sweeteners - sugar, honey, maple syrup, molasses, stevia\n257944: Bread & Pastry Mixes\n257945: Cake & Cupcake Mixes\n257946: Cookie & Brownie Mixes\n257989: Cooking Oils - olive oil, coconut oil, vegetable oil\n257978: Salt - sea salt, kosher salt, himalayan, canning salt\n257977: Pepper & Chili - black pepper, cayenne, paprika, chili powder\n257980: Spices - cinnamon, cumin, turmeric, nutmeg\n257979: Seasoning Mixes & Blends\n257983: Honey\n257984: Jam Jelly & Preserves\n257985: Nut Butters - peanut butter, almond butter, tahini\n257991: Dried Beans & Pulses - beans, lentils, split peas, chickpeas\n257988: Longlife Cooking & Baking Fats - butter powder, shortening, ghee\n258012: Dried Fruit & Nuts - raisins, dried fruit, nuts, seeds, trail mix\n258013: Popcorn kernels\n257995: Prepared Food & Ready Meals - mixes, soup mixes\n257971: Freeze-dried or Dehydrated Fruits & Vegetables\n20626: Food Storage - mylar bags, vacuum seal bags, oxygen absorbers, mason jars, buckets, canning supplies, storage containers\n184638: Grain Mills & Food Mills - manual or electric grain mills, wheat grinders\n133696: Food Dehydrators\n79631: Other Food & Beverages - anything food that does not fit above\n\nReturn ONLY valid JSON, no markdown, no explanation.";

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

// ── Debug: preview values without sending to eBay ────────────────────────────
app.post("/api/ebay/preview-xml", auth, async (req, res) => {
  const { name, ebayPrice, quantity, categoryId, conditionId, markup, imageUrl, brand, itemType, weightLbs } = req.body;
  const finalPrice = markup !== undefined ? parseFloat((ebayPrice * (1 + parseFloat(markup) / 100)).toFixed(2)) : ebayPrice;
  const totalOz = Math.round(parseFloat(weightLbs) * 16);
  const weightPounds = Math.floor(totalOz / 16);
  const weightOunces = totalOz % 16;
  const noConditionCategories = ["177762", "14308", "181000", "3025"];
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
app.post("/api/ebay/check-listed", auth, async (req, res) => {
  const { skus } = req.body;
  if (!skus || !skus.length) return res.json({});

  const skuSet = new Set(skus.map(String));
  const result = {};
  skus.forEach(s => { result[String(s)] = null; });

  try {
    for (let page = 1; page <= 4; page++) {
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
        if (skuSet.has(sku)) {
          const price = parseFloat(
            item.SellingStatus?.CurrentPrice?.["_"] ||
            item.BuyItNowPrice?.["_"] ||
            item.StartPrice?.["_"] || "0"
          );
          result[sku] = { itemId: item.ItemID, ebayPrice: price };
        }
      });

      const totalPages = parseInt(resp?.ActiveList?.PaginationResult?.TotalNumberOfPages || "1");
      if (page >= totalPages) break;
    }
    res.json(result);
  } catch (e) {
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

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`eBay-Square bridge running on port ${PORT}`);
});
