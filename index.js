const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const path = require('path');
const app = express();
const cors = require("cors");
const bcrypt = require('bcrypt');
require('dotenv').config();


app.use(cors({
  origin: ["http://localhost:1234", "https://fitpage.netlify.app"]// your React app's origin
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use("/uploads", express.static("uploads"));


const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Error connecting to DB:", err);
  } else {
    console.log("✅ Connected to DB");
    connection.release(); 
  }
});

// Multer setup
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

// POST /api/review/:productId
app.post('/api/review/:productId', upload.single('photo'), (req, res) => {
  const { productId } = req.params;
  const { userId, rating, reviewText } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  // Validate
  if (!userId || !rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  // Check for duplicate
  const checkSql = 'SELECT * FROM reviews WHERE user_id = ? AND product_id = ?';
  db.query(checkSql, [userId, productId], (err, result) => {
    if (err) return res.status(500).json({ error: 'DB error' });

    if (result.length > 0) {
      return res.status(400).json({ error: 'Review already submitted' });
    }

    // Insert review
    const insertSql = `
      INSERT INTO reviews (user_id, product_id, rating, review_text, image_url)
      VALUES (?, ?, ?, ?, ?)
    `;

    db.query(
      insertSql,
      [userId, productId, rating, reviewText, imageUrl],
      (err) => {
        if (err) {
          console.error("MySQL Insert Error:", err);
          return res.status(500).json({ error: 'Insert failed', details: err.message });
        }

        return res.status(200).json({ message: 'Review submitted' });
      }
    );
  });
});


// 🔐 Register a user
app.post("/api/register", async (req, res) => {
    console.log("req.body:", req.body); 
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "All fields are required" });

  const hashedPassword = await bcrypt.hash(password, 10);

  const sql = "INSERT INTO users (name, email, password) VALUES (?, ?, ?)";
  db.query(sql, [name, email, hashedPassword], (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "Email already exists" });
      }
      else{
        console.error("MySQL Query Error:", err);
        return res.status(500).json({ error: "Database error" });
      }
    }
    res.status(201).json({ message: "User registered successfully" });
  });
});


// 🔐 Login a user
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  const sql = "SELECT * FROM users WHERE email = ?";
  db.query(sql, [email], async (err, results) => {
    if (err) {
      console.error("MySQL Query Error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    res.json({ message: "Login successful", userId: user.id });
  });
});

// 🛒 Add a new product
app.post("/api/add", (req, res) => {
  const { name, imageUrl } = req.body;

  // Validation
  if (!name || !imageUrl) {
    return res.status(400).json({ error: "Product name and image URL are required" });
  }

  const sql = "INSERT INTO products (name, image_url) VALUES (?, ?)";
  db.query(sql, [name, imageUrl], (err, result) => {
    if (err){
      console.error("MySQL Query Error:", err);
      return res.status(500).json({ error: "Failed to add product" });
    }
    else{
    res.status(201).json({
      message: "Product added successfully",
      productId: result.insertId,
    });
  }
  });
});


// 🛒 Get all products
app.get("/api/products-with-reviews", (req, res) => {
  const sql = `
    SELECT 
      p.id AS product_id,
      p.name AS product_name,
      p.image_url AS product_image,
      r.id AS review_id,
      r.rating,
      r.review_text,
      r.image_url AS review_image,
      r.created_at,
      u.id AS user_id,
      u.name AS user_name,
      avg_table.avg_rating,
      avg_table.rating_count
    FROM products p
    LEFT JOIN reviews r ON p.id = r.product_id
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN (
      SELECT 
        product_id,
        ROUND(AVG(rating), 1) AS avg_rating,
        COUNT(*) AS rating_count
      FROM reviews
      GROUP BY product_id
    ) AS avg_table ON p.id = avg_table.product_id
    ORDER BY p.id, r.created_at DESC
  `;

  db.query(sql, (err, results) => {
    if (err){
      console.error("MySQL Query Error:", err);
      return res.status(500).json({ error: "Database error" });
    } 

    const productMap = {};

    results.forEach((row) => {
      if (!productMap[row.product_id]) {
        productMap[row.product_id] = {
          id: row.product_id,
          name: row.product_name,
          image: row.product_image,
          rating: {
            avg: row.avg_rating || 0,
            count: row.rating_count || 0
          },
          reviews: []
        };
      }

      if (row.review_id) {
        productMap[row.product_id].reviews.push({
          id: row.review_id,
          rating: row.rating,
          comment: row.review_text,
          imageUrl: row.review_image,
          createdAt: row.created_at,
          user: {
            id: row.user_id,
            name: row.user_name
          }
        });
      }
    });

    const products = Object.values(productMap);
    res.json(products);
  });
});






// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
