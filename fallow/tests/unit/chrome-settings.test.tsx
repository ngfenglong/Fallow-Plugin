import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeSettingsPanel } from '../../src/ui/dashboard/ChromeSettingsPanel';

// Task 6 (originally plan Task 19). fireEvent, not @testing-library/user-event -- this
// repo's Tech Stack excludes user-event (see dashboard.test.tsx/popup.test.tsx's own note),
// so every interaction below uses fireEvent in place of the brief's illustrative
// `user.click`. Own local fake-chrome harness, scoped to only what this panel needs
// (chrome.tabs.create for the settings-page-opening button, chrome.permissions.request to
// prove it is never called) -- same convention as dashboard.test.tsx/popup.test.tsx's own
// installChrome(), not a shared helper.

const fake = {
  lastCreatedUrl: null as string | null,
  calls: { permissionsRequest: 0 },
};

function installChrome() {
  fake.lastCreatedUrl = null;
  fake.calls = { permissionsRequest: 0 };
  vi.stubGlobal('chrome', {
    tabs: {
      create: vi.fn((opts: { url: string }) => {
        fake.lastCreatedUrl = opts.url;
        return Promise.resolve({ id: 1 });
      }),
    },
    permissions: {
      request: vi.fn(() => {
        fake.calls.permissionsRequest += 1;
        return Promise.resolve(true);
      }),
    },
  });
}

beforeEach(() => {
  installChrome();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChromeSettingsPanel', () => {
  it('lists all five settings rows', () => {
    render(<ChromeSettingsPanel />);
    expect(screen.getAllByTestId(/^settings-row-/)).toHaveLength(5);
  });

  it('shows no on/off control for any chrome setting', () => {
    render(<ChromeSettingsPanel />);
    expect(within(screen.getByTestId('settings-panel')).queryAllByRole('switch')).toEqual([]);
    expect(within(screen.getByTestId('settings-panel')).queryAllByRole('checkbox')).toEqual([]);
  });

  it('says plainly that Fallow cannot read Memory Saver', () => {
    render(<ChromeSettingsPanel />);
    expect(screen.getByText(/its state is not read by this extension/i)).toBeInTheDocument();
  });

  it('embeds no settings page', () => {
    render(<ChromeSettingsPanel />);
    expect(document.querySelector('iframe')).toBe(null);
  });

  it('opens the performance settings route on a click and offers a copyable address', () => {
    render(<ChromeSettingsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /open chrome performance settings/i }));
    expect(fake.lastCreatedUrl).toBe('chrome://settings/performance');
    expect(screen.getByText('chrome://settings/performance')).toBeInTheDocument();
  });

  it('gives macOS task manager instructions', () => {
    render(<ChromeSettingsPanel />);
    expect(screen.getByTestId('settings-row-task-manager')).toHaveTextContent(/Window.*Task Manager/i);
  });

  it('separates Fallow protected sites from Chrome own list', () => {
    render(<ChromeSettingsPanel />);
    expect(screen.getByText(/independent from this extension/i)).toBeInTheDocument();
  });

  it('never asks for the privacy permission in this version', () => {
    render(<ChromeSettingsPanel />);
    expect(fake.calls.permissionsRequest).toBe(0);
  });
});
