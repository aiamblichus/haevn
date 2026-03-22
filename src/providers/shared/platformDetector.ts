/**
 * Platform Detection Utility
 *
 * Provides unified platform detection across all providers.
 * Consolidates 8 different `isPlatform()` implementations into a single,
 * consistent utility with proper error handling and case-insensitive matching.
 */

export interface PlatformDetectionConfig {
  /**
   * List of hostname patterns to match (case-insensitive)
   */
  hostnames?: string[];

  /**
   * List of DOM selectors that must be present
   */
  metaSelectors?: string[];

  /**
   * Custom detection function (for complex cases)
   */
  customDetector?: () => boolean;
}

/**
 * Detect if current page matches the platform configuration
 *
 * Checks are performed in order:
 * 1. Hostname matching (if configured)
 * 2. Meta selector matching (if configured)
 * 3. Custom detector (if configured)
 *
 * @param config Platform detection configuration
 * @returns true if platform is detected, false otherwise
 */
export function detectPlatform(config: PlatformDetectionConfig): boolean {
  // Hostname matching
  if (config.hostnames && config.hostnames.length > 0) {
    const hostname = window.location.hostname.toLowerCase();
    if (config.hostnames.some((pattern) => hostname.includes(pattern.toLowerCase()))) {
      return true;
    }
  }

  // Meta selector matching
  if (config.metaSelectors && config.metaSelectors.length > 0) {
    try {
      if (config.metaSelectors.some((sel) => !!document.querySelector(sel))) {
        return true;
      }
    } catch {
      // Ignore selector errors
    }
  }

  // Custom detector
  if (config.customDetector) {
    try {
      return config.customDetector();
    } catch {
      return false;
    }
  }

  return false;
}
