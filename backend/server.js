// backend/server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./database");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");



const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());


// Middleware to check JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: "Missing token." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, userData) => {
    if (err) {
      return res.status(403).json({ error: "Invalid token." });
    }
    // Save user info in request for later
    req.user = userData;
    next();
  });
}


// Test route
app.get("/", (req, res) => {
  res.json({ message: "MealShare API is running 🚀" });
});

// Register route
app.post("/register", (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required." });
  }

  const userRole = role === "merchant" ? "merchant" : "user";

  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      console.error("Error hashing password:", err);
      return res.status(500).json({ error: "Internal server error." });
    }

    const sql = `
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `;
    const params = [name, email, hash, userRole];

    db.run(sql, params, function (dbErr) {
      if (dbErr) {
        console.error("Error inserting user:", dbErr);
        if (dbErr.message.includes("UNIQUE constraint failed")) {
          return res.status(400).json({ error: "Email is already registered." });
        }
        return res.status(500).json({ error: "Database error." });
      }

      // this.lastID is the new user's id
      res.status(201).json({
        id: this.lastID,
        name,
        email,
        role: userRole,
        created_at: new Date().toISOString(),
      });
    });
  });
});


// Login route
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const sql = `SELECT * FROM users WHERE email = ?`;

  db.get(sql, [email], (err, user) => {
    if (err) {
      return res.status(500).json({ error: "Database error." });
    }
    if (!user) {
      return res.status(400).json({ error: "User not found." });
    }

    bcrypt.compare(password, user.password_hash, (compareErr, match) => {
      if (!match) {
        return res.status(400).json({ error: "Incorrect password." });
      }

      // Create JWT token
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      res.json({
        message: "Login successful!",
        token: token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role
        }
      });
    });
  });
});


// Create meal (merchant only)
app.post("/meals", authenticateToken, (req, res) => {
  const { title, description, portions_available, pickup_time } = req.body;

  if (req.user.role !== "merchant") {
    return res.status(403).json({ error: "Only merchants can create meals." });
  }

  if (!title || !portions_available || !pickup_time) {
    return res.status(400).json({ error: "Title, portions and pickup_time are required." });
  }

  const sql = `
    INSERT INTO meals (merchant_id, title, description, portions_available, pickup_time)
    VALUES (?, ?, ?, ?, ?)
  `;
  const params = [
    req.user.id,
    title,
    description || "",
    portions_available,
    pickup_time,
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error("Error inserting meal:", err);
      return res.status(500).json({ error: "Database error." });
    }

    res.status(201).json({
      id: this.lastID,
      merchant_id: req.user.id,
      title,
      description: description || "",
      portions_available,
      pickup_time,
      created_at: new Date().toISOString(),
    });
  });
});


// Get all meals (visible to everyone)
app.get("/meals", (req, res) => {
  const sql = `
    SELECT meals.*, users.name AS merchant_name
    FROM meals
    INNER JOIN users ON meals.merchant_id = users.id
    ORDER BY meals.created_at DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Error fetching meals:", err);
      return res.status(500).json({ error: "Database error." });
    }
    res.json(rows);
  });
});


// Reserve a meal (user only, max 1 reservation every 3 days)
app.post("/meals/:id/reserve", authenticateToken, (req, res) => {
  const mealId = req.params.id;
  const userId = req.user.id;

  if (req.user.role !== "user") {
    return res.status(403).json({ error: "Only regular users can reserve meals." });
  }

  // Check if user already has a reservation in the last 3 days
  const recentReservationSql = `
    SELECT * FROM reservations
    WHERE user_id = ?
      AND created_at > datetime('now', '-3 days')
    ORDER BY created_at DESC
    LIMIT 1
  `;

  db.get(recentReservationSql, [userId], (err, recent) => {
    if (err) {
      console.error("Error checking recent reservations:", err);
      return res.status(500).json({ error: "Database error." });
    }

    if (recent) {
      return res.status(400).json({
        error: "You can only reserve one meal every 3 days."
      });
    }

    // Check meal exists and has portions left and pickup_time not passed
    const mealSql = `
      SELECT * FROM meals
      WHERE id = ?
    `;

    db.get(mealSql, [mealId], (mealErr, meal) => {
      if (mealErr) {
        console.error("Error fetching meal:", mealErr);
        return res.status(500).json({ error: "Database error." });
      }

      if (!meal) {
        return res.status(404).json({ error: "Meal not found." });
      }

      if (meal.portions_available <= 0) {
        return res.status(400).json({ error: "No portions left for this meal." });
      }

      // Insert reservation
      const insertSql = `
        INSERT INTO reservations (user_id, meal_id)
        VALUES (?, ?)
      `;

      db.run(insertSql, [userId, mealId], function (insertErr) {
        if (insertErr) {
          console.error("Error inserting reservation:", insertErr);
          return res.status(500).json({ error: "Database error." });
        }

        // Decrease portions
        const updateSql = `
          UPDATE meals
          SET portions_available = portions_available - 1
          WHERE id = ?
        `;

        db.run(updateSql, [mealId], function (updateErr) {
          if (updateErr) {
            console.error("Error updating meal portions:", updateErr);
            return res.status(500).json({ error: "Database error." });
          }

          res.status(201).json({
            message: "Reservation created successfully.",
            reservation: {
              id: this.lastID,
              user_id: userId,
              meal_id: mealId
            }
          });
        });
      });
    });
  });
});





// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
