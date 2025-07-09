require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static("public")); // Serve frontend

// ✅ Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// ✅ Define Schema
const paymentSchema = new mongoose.Schema({
  phone: String,
  amount: Number,
  checkoutRequestID: String,
  resultCode: Number,
  status: String,
  timestamp: { type: Date, default: Date.now },
});

const Payment = mongoose.model("Payment", paymentSchema);

// 🔁 In-memory status tracker
const paymentStatus = {};

// ✅ Access Token Middleware
const generateToken = async (req, res, next) => {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");

  try {
    const response = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } }
    );

    req.token = response.data.access_token;
    next();
  } catch (err) {
    console.error("❌ Token error:", err.message);
    return res.status(500).json({ error: "Failed to generate access token" });
  }
};

// ✅ STK Push Initiator (for Till)
app.post("/stk", generateToken, async (req, res) => {
  try {
    const rawPhone = req.body.phone?.trim();
    const amount = parseInt(req.body.amount);

    if (!rawPhone || isNaN(amount)) {
      return res.status(400).json({ error: "Invalid phone or amount" });
    }

    const phone = rawPhone.startsWith("0")
      ? `254${rawPhone.substring(1)}`
      : rawPhone.startsWith("254")
      ? rawPhone
      : `254${rawPhone}`; // Fallback

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);

    const shortcode = process.env.MPESA_TILL;
    const passkey = process.env.MPESA_PASSKEY;
    const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline", // 🔁 BUY GOODS
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: "JT Mini Mart",
      TransactionDesc: "Buy Goods Payment",
    };

    const response = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      payload,
      {
        headers: {
          Authorization: `Bearer ${req.token}`,
        },
      }
    );

    const checkoutRequestID = response.data.CheckoutRequestID;
    paymentStatus[checkoutRequestID] = { status: "pending" };

    console.log("✅ STK Push initiated:", response.data);
    res.status(200).json(response.data);
  } catch (err) {
    console.error("❌ STK Push Error:", err.response?.data || err.message);
    res.status(500).json({ error: "STK Push initiation failed" });
  }
});

// ✅ Callback from Safaricom
app.post("/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.sendStatus(400);

    const { CheckoutRequestID, ResultCode, CallbackMetadata } = callback;
    const status = ResultCode === 0 ? "success" : "failed";

    paymentStatus[CheckoutRequestID] = { status };

    const phone = CallbackMetadata?.Item?.find(i => i.Name === "PhoneNumber")?.Value || "unknown";
    const amount = CallbackMetadata?.Item?.find(i => i.Name === "Amount")?.Value || 0;

    const payment = new Payment({
      phone,
      amount,
      checkoutRequestID: CheckoutRequestID,
      resultCode: ResultCode,
      status,
    });

    await payment.save();
    console.log("✅ Callback saved to DB:", payment);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Callback Processing Error:", err.message);
    res.sendStatus(500);
  }
});

// ✅ Status Checker
app.get("/status/:id", (req, res) => {
  const id = req.params.id;
  const status = paymentStatus[id];
  if (!status) return res.status(404).json({ status: "not found" });
  res.json(status);
});

// ✅ Health check
app.get("/", (req, res) => {
  res.send("<h1>✅ JT Mini Mart MPESA TILL STK Integration Running</h1>");
});

// ✅ Start server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
