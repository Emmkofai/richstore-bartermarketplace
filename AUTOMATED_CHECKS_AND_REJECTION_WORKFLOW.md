# Automated System Checks & Rejection Workflow
## RichStore Marketplace — Content Moderation Policy

**Effective Date:** September 2026  
**Version:** 1.0  
**Applies to:** All Seller Submissions, Image Uploads & Listing Modifications

---

## 1. Overview

RichStore employs a multi-stage automated moderation pipeline that screens every
product listing BEFORE it reaches the public marketplace catalog. No listing ever
appears in the public feed without successfully passing through all checkpoints.
A failure at any single stage results in an immediate rejection with a specific,
actionable error message returned to the seller.

---

## 2. Moderation Pipeline — Stages

Every listing submission flows through the following sequential stages:

```
Seller Submits  →  Stage 1: Text Screening
                →  Stage 2: Image Quality Check
                →  Stage 3: Nudity / NSFW Scan
                →  Stage 4: Description-Category Cross-Match
                →  Stage 5: Stock & Price Validation
                →  Stage 6: Rate Limit Check
                →  Stage 7: Community Reporting (post-publish)
                →  ✅ Published to Catalog
```

If a listing fails at ANY gate, it is rejected and does NOT proceed further.

---

## 3. Stage Details

### STAGE 1 — Real-Time Prohibited Text Screening
**Timing:** Instant, at form submission  
**Function:** `validateProductPolicy()` in server.js

The system scans the listing's Title, Description, and Category fields against a
curated blocklist of prohibited terms using regex word-boundary matching.

**Prohibited Term Categories:**

| Category                          | Example Terms                                                       |
|-----------------------------------|---------------------------------------------------------------------|
| Adult & Pornographic              | porn, pornography, xxx, nude, naked, nsfw, erotic, onlyfans, camgirl |
| Sex Toys & Adult Novelties        | sex toy, dildo, vibrator, fleshlight, bondage, fetish               |
| Sexual Exploitation & CSAM        | escort, prostitution, csam, child sexual, pedophile, voyeur         |
| Explicit Sexual Acts              | blowjob, handjob, orgasm, masturbat, sensual massage                |

**Triggers:**
- New listing created (POST /api/listings)
- Existing listing updated (PUT /api/listings/:id)

**On Rejection:**
- HTTP 400 returned
- Listing is NOT saved to the database
- Error: "Listing rejected by RichStore Content Safety: Items related to nudity,
  pornography, adult novelties, or sexual exploitation are strictly prohibited."
- Policy Reference: Section 2.1 & 2.2

---

### STAGE 2 — Image Quality & Dimension Verification
**Timing:** < 500ms, at image upload  
**Function:** Sharp image processing pipeline in POST /api/upload-image

| Validation Rule     | Threshold                         | Rejection Message                                           |
|---------------------|-----------------------------------|-------------------------------------------------------------|
| File Type           | JPEG, PNG, GIF, WebP, AVIF, SVG   | Non-image files or corrupted data rejected                  |
| File Size           | Maximum 5 MB                      | "File too large. Maximum allowed size is 5MB."              |
| Minimum Resolution  | 400 × 400 pixels                  | "Image rejected: Image too blurry or below 400×400px."      |
| File Corruption     | Must pass Sharp metadata check     | "Upload failed — file is corrupted or not a valid image."   |
| Blank / Empty Files | Must contain non-trivial pixel data | "Upload rejected — blank or placeholder image detected."   |

**On Rejection:**
- HTTP 400 returned
- Image file is NOT stored on disk
- No upload path is returned to the frontend

---

### STAGE 3 — Nudity & NSFW Computer-Vision Detection
**Timing:** < 800ms, at image upload  
**Function:** `detectNudity()` in server.js

Every uploaded image is processed by a multi-color-space skin detection system
with connected-region analysis. This runs server-side in real-time.

**How the Algorithm Works:**

**Step A — Multi-Color-Space Skin Pixel Classification:**
Each pixel is evaluated across three independent color models simultaneously.
A pixel is classified as "skin" only when at least 2 of 3 models agree:

1. **RGB Model (Peer et al.):**
   - R > 95, G > 40, B > 20
   - max(R,G,B) - min(R,G,B) > 15
   - |R - G| > 15, R > G, R > B

2. **YCbCr Model (Kovac et al.):**
   - Y > 75, Cb in [85, 135], Cr in [135, 180]

3. **HSV Model:**
   - Hue in [0°, 50°] or >= 340°
   - Saturation in [0.15, 0.68]
   - Value >= 0.35

**Step B — BFS Connected-Region Analysis:**
Classified skin pixels are analyzed using Breadth-First Search (BFS) to find
the largest contiguous skin-colored region. This prevents false positives from
scattered small skin patches (e.g., hands or face in a product photo).

**Nudity Flagging Thresholds (image is REJECTED if EITHER condition is met):**

| Condition   | Rule                                                              |
|-------------|-------------------------------------------------------------------|
| Condition A | Skin ratio >= 30% AND largest contiguous region >= 20% of image   |
| Condition B | Largest contiguous region >= 35% of image (regardless of overall) |

**On Rejection:**
- HTTP 400 returned
- Image is deleted from disk immediately
- Listing is NOT created or updated
- Error: "Image rejected: This image has been flagged by our automated content
  safety system as containing nudity or sexually explicit material."
- Policy Reference: Section 2.1

---

### STAGE 4 — Description-Image & Category Cross-Validation
**Timing:** Instant, at form submission  
**Function:** `validateProductPolicy()` in server.js

**Deceptive Pattern Detection:**
The system matches the combined title + description against known fraud patterns:

| Pattern Type              | Example Matches                            |
|---------------------------|--------------------------------------------|
| Empty box scams           | "empty box only", "box only"               |
| Picture-only sales        | "picture only", "photo only"               |
| Hidden disclaimers        | "no phone inside", "no device inside"      |
| Misleading auction tactics | "read description before bidding"          |

**Category-Title Mismatch Detection:**

- Electronics category: Rejects if title contains fashion items (dress, high heels,
  wig, lipstick) without electronic context.
- Books category: Rejects if title contains electronics/fashion items (smartphone,
  laptop, sneaker, refrigerator).

**On Rejection:**
- HTTP 400 returned
- Error: "Listing rejected: Category 'Electronics' does not match the product
  'Women's High Heels'. Please select the correct category."
- Policy Reference: Section 2.4

---

### STAGE 5 — Stock, Pricing & Data Integrity Validation
**Timing:** Instant, at form submission

| Field       | Validation Rule                      | Rejection Condition               |
|-------------|--------------------------------------|-----------------------------------|
| Title       | Required, non-empty string           | Missing or blank                  |
| Description | Required, non-empty string           | Missing or blank                  |
| Price       | Must be a positive number > 0        | Zero, negative, or non-numeric    |
| Stock       | Must be an integer >= 1              | Zero or negative                  |
| Category    | Required, non-empty string           | Missing or uncategorized          |
| Condition   | Required (New / Used / Refurbished)  | Missing condition label           |
| Seller      | Authenticated user token required    | Anonymous or expired session      |

---

### STAGE 6 — Rate Limiting & Spam Prevention
**Timing:** Continuous, per request  
**Function:** `checkRateLimit()` in server.js

| Endpoint                  | Rate Limit            | Time Window              |
|---------------------------|-----------------------|--------------------------|
| POST /api/checkout        | 20 requests max       | Per 15 minutes per user  |
| POST /api/signup          | 5 accounts max        | Per 60 minutes per IP    |
| POST /api/verify-otp      | Brute-force protected | Per session              |
| POST /api/upload-image    | File-type/size gating | Per request              |

**On Rejection:**
- HTTP 429 returned
- Error: "Too many checkout attempts. Please wait Xs before trying again."

---

### STAGE 7 — Community Reporting & Administrative Takedown
**Timing:** Post-publish, ongoing

- **Community Flagging:** Any buyer can report a listing they believe violates
  the posting policy. Flagged listings are queued for admin review.
- **Admin Review Dashboard:** Admins have tools to view, update, and remove
  listings and orders system-wide.
- **Bulk Order Clearing:** Admins can clear all orders through the admin control
  panel with confirmation safeguards (DELETE /api/orders).
- **Listing Deletion:** Admins can permanently delete any listing (DELETE /api/listings/:id).

---

## 4. Rejection Workflow — What Happens When a Listing is Rejected

| Step | Action               | Details                                                                 |
|------|----------------------|-------------------------------------------------------------------------|
| 1    | Immediate Block      | Listing is NOT persisted to the database. No record is created.         |
| 2    | Image Cleanup        | If a flagged image was uploaded, it is deleted from /uploads/.          |
| 3    | Error Response       | Seller receives HTTP 400 with a clear error message and policy section. |
| 4    | Server Logging       | Violation is logged to server console with diagnostic data.             |
| 5    | Seller Notification  | Frontend shows a toast notification with the violation reason.          |

---

## 5. Strike Escalation & Account Sanctions

### Tier 1 — Warning & Educational Prompt (1st Offense)
Listing is rejected with a detailed message explaining why and how to fix it.
No account sanctions. Seller can immediately re-submit a corrected listing.

### Tier 2 — Temporary Posting Suspension (2+ Deceptive Violations in 30 Days)
Seller's ability to create new listings is suspended for 14 days. All existing
listings remain visible but are flagged for admin review. Seller must acknowledge
and agree to the posting policy before reinstatement.

### Tier 3 — Permanent Ban & Legal Referral (CSAM, Exploitation, Extreme Violations)
Immediate permanent account termination. All listings removed. Verified phone
number and IP address permanently blacklisted. For CSAM or sexual exploitation
content, the incident is immediately reported to law enforcement and international
child protection authorities.

---

## 6. Technical Implementation Reference

| Stage              | Function / Module            | Location in server.js                                    |
|--------------------|------------------------------|----------------------------------------------------------|
| Text Screening     | validateProductPolicy()      | PROHIBITED_ADULT_TERMS blocklist + regex matching        |
| Deceptive Patterns | validateProductPolicy()      | DECEPTIVE_MISMATCH_PATTERNS regex array                  |
| Image Quality      | sharp() metadata check       | POST /api/upload-image handler                           |
| Nudity Detection   | detectNudity()               | Multi-color-space (RGB, YCbCr, HSV) + BFS region scan   |
| Category Mismatch  | validateProductPolicy()      | Cross-validates category vs. title keywords              |
| Rate Limiting      | checkRateLimit()             | Token-bucket per user+IP with configurable window        |
| Admin Takedown     | DELETE /api/listings/:id     | Admin-authenticated listing removal                      |
| Bulk Order Clear   | DELETE /api/orders           | Admin-only system-wide order purge with confirmation     |

---

## 7. Seller Appeals & Dispute Resolution

1. Review the specific error message — it includes the exact policy section violated.
2. Correct the listing (retake clearer photos, fix title/description, select
   correct category) and re-submit.
3. If the rejection was a false positive, contact the RichStore Trust & Safety
   Team with the original product images and documentation proving legitimate use.
4. An administrator will manually review the appeal within 24–48 hours and either
   whitelist the listing or uphold the rejection with an explanation.

**Note on False Positives:** The nudity detection system uses statistical skin-color
analysis which may occasionally flag legitimate product images with large skin-colored
areas (e.g., beige clothing, leather goods). Sellers should photograph products on a
contrasting background to reduce false detections.

---

*RichStore. Copyright © 2026 — Automated Trust, Safety & Content Moderation Framework.*
