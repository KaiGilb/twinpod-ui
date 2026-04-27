# @kaigilb/twinpod-ui

Reusable Vue 3 composables and components for TwinPod applications.

## Installation

This package is consumed as a local file dependency:

```json
{
  "dependencies": {
    "@kaigilb/twinpod-ui": "file:../twinpod-ui"
  }
}
```

## Exported Composables

### `useCreditLedger(podBasePath)`
Credit balance, Stripe purchase flow, trial state, per-token decrement.

**Returns:** `{ credits, buyCredits, decrementCredits, trialActive, trialDaysRemaining }`

### `useTrial(trialEndDate)`
Client-side countdown timer for trial period.

**Returns:** `{ daysRemaining, hoursRemaining, expired }`

### `usePodWorkbook(documentUri)`
Read/write markdown document to/from TwinPod pod.

**Returns:** `{ content, save, load, loading, error }`

### `useSessionIndex(indexUri)`
Session list management against TwinPod.

**Returns:** `{ sessions, addSession, deleteSession, loading }`

## Exported Components

### `<LoginView>`
OIDC login page with server selector.

**Props:** `defaultServer`, `titleText`, `subtitleText`, `backgroundImage`  
**Slots:** `#footer`  
**CSS variables:** `--twinpod-ui-login-bg`, `--twinpod-ui-primary-color`

### `<SessionPanel>`
Left drawer with project list + logout button.

**Props:** `appName`, `appLogo`, `panelWidth`  
**Slots:** `#header`, `#footer`, `#project-item`  
**CSS variables:** `--twinpod-ui-panel-bg`, `--twinpod-ui-panel-width`

### `<BuyCreditsButton>`
Stripe credit bundle purchase button.

**Props:** `buttonText`, `stripePublishableKey`  
**CSS variables:** `--twinpod-ui-button-bg`, `--twinpod-ui-button-text`

### `<SessionCostGate>`
Gate shown when credits/trial exhausted.

**Props:** `messageText`, `showUpgradeButton`  
**Slots:** `#message`, `#actions`  
**CSS variables:** `--twinpod-ui-gate-bg`, `--twinpod-ui-gate-border`

## Customization

Components are customized via:
- **Props** for functional parameters
- **Slots** for structural overrides
- **CSS custom properties** for visual styling (never raw hex values)

See `9 - Standard/Rule_Code_design-guide.md` for design token constraints.

## Development

This package is part of the Kai-Zen AI development system. Components are extracted from projects when they prove to be reusable across multiple TwinPod applications.

See `9 - Standard/Reference_Code_TwinPod-UI-Package.md` in the Kai-Zen vault for extraction and usage guidelines.
