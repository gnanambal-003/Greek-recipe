import express from "express";
import cors from "cors";
import * as XLSX from "xlsx";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "Your api key";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});

const EXCEL_PATH = "C:/Users/gnana/Downloads/products.xlsx";

type ProductRow = {
  "Product ID": string;
  Name: string;
  Price: number;
  Availability: number;
  Decription: string;
  Image: string;
};

let PRODUCTS: ProductRow[] = [];

try {
  const wb = XLSX.readFile(EXCEL_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  PRODUCTS = XLSX.utils.sheet_to_json(sheet);
  console.log("✅ Products loaded:", PRODUCTS.length);
} catch (err) {
  console.error("❌ Excel load failed:", err);
}

const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
    try {
      let { recipeText, people } = req.body;
  
      // 🔧 normalize
      recipeText = (recipeText || "").toString().trim();
      const peopleNum = Number(people);
  
      // ✅ ask people if missing
      if (!Number.isFinite(peopleNum) || peopleNum <= 0) {
        return res.json({
          type: "ask_people",
          reply: recipeText
            ? `For how many people should I prepare ${recipeText}?`
            : "For how many people are you cooking?",
          products: [],
        });
      }
  
      // ✅ ask recipe if missing
      if (!recipeText || recipeText.length < 3) {
        return res.json({
          type: "out_of_scope",
          reply: "Please tell me the recipe name.",
          products: [],
        });
      }
  
      // =====================================================
      // STEP 1 — Compact catalog for Gemini
      // =====================================================
  
      const catalogForLLM = PRODUCTS.slice(0, 1200).map((p) => ({
        id: String(p["Product ID"]).trim(),
        name: p.Name,
        price: p.Price,
        desc: (p.Decription || "").slice(0, 120),
      }));
  
      // =====================================================
      // STEP 2 — Gemini selects products
      // =====================================================
  
      const prompt = `
  You are an expert Greek cooking assistant and product selector.
  
  USER REQUEST:
  "${recipeText}"
  
  SERVINGS: ${peopleNum}
  
  AVAILABLE PRODUCT CATALOG (JSON):
  ${JSON.stringify(catalogForLLM)}
  
  YOUR JOB:
  
  STEP 1 — Understand if the user specified a clear dish.
  
  If the user request is TOO BROAD (examples: "pizza", "pasta", "sandwich", "salad"):
  
  → Ask a follow-up question to clarify the dish type.
  → DO NOT select products yet.
  
  STEP 2 — If the dish is clear:
  
  → Infer required ingredients
  → Select best matching products from catalog
  → Estimate realistic quantity per product
  
  QUANTITY RULES:
  
  - Major ingredient → scale with people
  - Minor ingredient → usually 1 pack
  - Sauce → usually 1 pack for ≤4 people
  - Never blindly set quantity = people
  
  STRICT RULES:
  
  - ONLY select from provided catalog
  - DO NOT invent products
  - Use semantic understanding
  - Return 4–8 products when dish is clear
  
  OUTPUT STRICT JSON ONLY:
  
  {
    "need_followup": boolean,
    "followup_question": string,
    "products": [
      {
        "id": "product_id",
        "quantity": number
      }
    ]
  }
  `;
  
      const result = await model.generateContent(prompt);
      const raw = result.response.text();
  
      // =====================================================
      // STEP 3 — Parse LLM safely
      // =====================================================
  
      let parsed: any;
  
      try {
        const cleaned = raw.replace(/```json/g, "").replace(/```/g, "");
        parsed = JSON.parse(cleaned);
      } catch (err) {
        console.log("⚠️ LLM parse failed:", raw);
        parsed = { need_followup: false, products: [] };
      }
  
      // =====================================================
      // STEP 4 — Follow-up handling
      // =====================================================
  
      if (parsed.need_followup) {
        return res.json({
          type: "ask_dish",
          reply:
            parsed.followup_question ||
            "Could you clarify the dish type?",
          products: [],
        });
      }
  
      // =====================================================
      // STEP 5 — Map quantities from LLM
      // =====================================================
  
      const qtyMap = new Map(
        (parsed.products || []).map((p: any) => [
          String(p.id).trim(),
          Number(p.quantity) || 1,
        ])
      );
  
      // ✅ SINGLE declaration (FIXES YOUR ERROR)
      const selectedProducts = PRODUCTS.filter((p) =>
        qtyMap.has(String(p["Product ID"]).trim())
      )
        .slice(0, 8)
        .map((p) => ({
          name: p.Name,
          price: p.Price,
          quantity: `${qtyMap.get(
            String(p["Product ID"]).trim()
          )} pack(s)`,
        }));
  
      if (!selectedProducts.length) {
        return res.json({
          type: "products",
          reply: "No relevant products found.",
          products: [],
        });
      }
  
      return res.json({
        type: "products",
        reply: `Found ${selectedProducts.length} relevant products.`,
        products: selectedProducts,
      });
    } catch (err) {
      console.error("❌ CHAT ERROR:", err);
      res.json({
        type: "out_of_scope",
        reply: "Error processing request.",
        products: [],
      });
    }
  });

app.get("/", (_, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<body>
<h2>Greek Recipe Assistant</h2>

<div id="chat" style="height:300px;overflow:auto;border:1px solid #ccc;padding:10px"></div>

<input id="input" style="width:70%" placeholder="Ask recipe..." />
<button onclick="send()">Send</button>

<script>
let people = null;
let recipe = null;

async function send(){
  const el = document.getElementById('input');
  const msg = el.value.trim();
  if(!msg) return;

  add('You: ' + msg);

  // 🔥 detect number
  const numberMatch = msg.match(/^\\d+$/);

  if (numberMatch) {
    people = Number(numberMatch[0]);
  } else {
    recipe = msg.replace(/\\b\\d+\\b/, "").trim();
    const inline = msg.match(/\\b(\\d+)\\b/);
    if (inline) people = Number(inline[1]);
  }

  const res = await fetch('/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      recipeText: recipe,
      people: people
    })
  });

  const data = await res.json();

  add('Bot: ' + data.reply);

  if (data.type === "products" && data.products?.length) {
    data.products.forEach(p => {
      add("🛒 " + p.name + " — ₹" + p.price + " — " + p.quantity);
    });
  }

  el.value='';
}

function add(t){
  const d=document.createElement('div');
  d.innerText=t;
  document.getElementById('chat').appendChild(d);
}
</script>
</body>
</html>
`);
});

app.listen(4000, () => {
  console.log("🚀 http://localhost:4000");
});
