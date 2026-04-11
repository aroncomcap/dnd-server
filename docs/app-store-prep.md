# App Store Preparation Guide

## Overview

Tavern Table is a web app that can be distributed via iOS App Store and Google Play Store using a PWA wrapper or React Native WebView. This document covers the steps needed.

## Current Architecture

- Web app: Express.js + Socket.io + static HTML files
- Auth: Passport.js (email, Google, Apple, Discord)
- Payments: Stripe Checkout (web)
- Hosting: Railway

## App Store Requirements

### iOS (Apple App Store)

**Sign in with Apple:** Already implemented (auth.js supports Apple OAuth). Required when any social login is offered.

**In-App Purchases:** Apple requires all digital goods purchased in-app to use their IAP system (30% cut).
- Current web pricing: $1/hr, $4.50/5hr, $15/20hr
- App Store pricing: $1.49/hr, $6.99/5hr, $22.99/20hr (covers 30% cut)
- Use RevenueCat SDK to unify Stripe (web) + StoreKit (iOS)

**RevenueCat Setup:**
1. Create RevenueCat account at https://www.revenuecat.com
2. Create "Tavern Table" project
3. Connect Stripe (for existing web payments)
4. Connect App Store Connect (for iOS IAP)
5. Define products matching current tiers:
   - `tt_playtime_1hr` — $1.49
   - `tt_playtime_5hr` — $6.99
   - `tt_playtime_20hr` — $22.99
6. Install `@revenuecat/purchases-js` for web, `react-native-purchases` for mobile

**App Review Guidelines:**
- Must not mention cheaper web pricing in the app
- Must not link to web purchase page from within the app
- App must be self-contained and functional
- Need privacy policy URL
- Need support URL

### Android (Google Play Store)

**Google Play Billing:** Same 30% cut requirement for digital goods.
- Same pricing as iOS
- Use RevenueCat to unify

**Requirements:**
- Privacy policy
- Target API level 34+
- Content rating questionnaire

## PWA Approach (Recommended for MVP)

Wrap the existing web app as a PWA. Simplest path to app stores.

### Steps:
1. Add `manifest.json` to public/:
```json
{
  "name": "Tavern Table",
  "short_name": "TavernTable",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a0f05",
  "theme_color": "#c8922a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

2. Add service worker for offline caching (basic)
3. Use PWABuilder (https://www.pwabuilder.com/) to generate iOS/Android packages
4. Or use Capacitor.js to wrap as native app with access to native APIs

### PWA Limitations:
- iOS Safari has limited PWA support (no push notifications, limited background)
- Can't use native IAP without a native wrapper
- For IAP, need Capacitor or React Native

## React Native Approach (For Full App Store Features)

If PWA limitations are too restrictive:

1. Create React Native app with WebView pointing to the hosted web app
2. Use `react-native-purchases` (RevenueCat) for IAP
3. Detect platform: web → Stripe, iOS → StoreKit, Android → Play Billing
4. Native push notifications for turn alerts

## Environment Variables Needed

```
# Stripe (already set)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# RevenueCat (when ready)
REVENUECAT_API_KEY=...

# Apple (when ready)
APPLE_CLIENT_ID=...
APPLE_CLIENT_SECRET=...
APPLE_TEAM_ID=...
APPLE_KEY_ID=...

# Google OAuth (already set for auth)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

## Pricing Matrix

| Product | Web (Stripe) | iOS (App Store) | Android (Play) |
|---------|-------------|-----------------|----------------|
| 1 Hour  | $1.00       | $1.49           | $1.49          |
| 5 Hours | $4.50       | $6.99           | $6.99          |
| 20 Hours| $15.00      | $22.99          | $22.99         |

## Timeline Estimate

1. **PWA wrapper + basic app store submission:** 1-2 weeks
2. **RevenueCat integration for IAP:** 1 week
3. **App review process:** 1-2 weeks (Apple), 3-5 days (Google)
4. **Total to app stores:** ~4-6 weeks

## Checklist Before Submission

- [ ] Privacy policy page at /privacy
- [ ] Terms of service page at /terms
- [ ] Support email configured
- [ ] App icons (1024x1024 for App Store, 512x512 for Play Store)
- [ ] Screenshots for each device size
- [ ] App description and keywords
- [ ] Age rating: 12+ (fantasy violence, in-app purchases)
- [ ] RevenueCat products configured and tested
- [ ] Sign in with Apple working end-to-end
- [ ] Test on physical iOS and Android devices
