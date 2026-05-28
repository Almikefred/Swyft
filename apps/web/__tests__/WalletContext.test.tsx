import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

import { WalletProvider, useWalletContext } from '@/context/WalletContext';

import type { WalletState } from '@/hooks/useWallet';

vi.mock('@/hooks/useWallet', () => {
  return {
    useWallet: vi.fn(),
  };
});

import { useWallet } from '@/hooks/useWallet';

function WalletConsumer() {
  const wallet = useWalletContext();
  return (
    <div>
      <div data-testid="address">{wallet.address ?? ''}</div>
      <div data-testid="error">{wallet.error ?? ''}</div>
      <div data-testid="connecting">{wallet.connecting ? 'yes' : 'no'}</div>
      <div data-testid="loading">{wallet.loading ? 'yes' : 'no'}</div>
      <div data-testid="hasSignTx">{wallet.signTransaction ? 'yes' : 'no'}</div>
    </div>
  );
}

describe('WalletContext', () => {
  const baseState: WalletState = {
    address: null,
    error: null,
    connecting: false,
    loading: false,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    signTransaction: null,
  };

  beforeEach(() => {
    vi.mocked(useWallet).mockReset();
  });

  it('throws if useWalletContext is used outside WalletProvider', () => {
    // React renders synchronously in test; the hook error is thrown during render.
    const BrokenConsumer = () => {
      useWalletContext();
      return null;
    };

    expect(() => render(<BrokenConsumer />)).toThrow(
      'useWalletContext must be used inside WalletProvider'
    );
  });

  it('provides wallet state from WalletProvider', () => {
    const state: WalletState = {
      ...baseState,
      address: 'GTEST123',
      error: 'WRONG_NETWORK',
      connecting: true,
      loading: true,
      signTransaction: vi.fn(async () => 'signed-xdr'),
    };

    vi.mocked(useWallet).mockReturnValue(state);

    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>
    );

    expect(screen.getByTestId('address')).toHaveTextContent('GTEST123');
    expect(screen.getByTestId('error')).toHaveTextContent('WRONG_NETWORK');
    expect(screen.getByTestId('connecting')).toHaveTextContent('yes');
    expect(screen.getByTestId('loading')).toHaveTextContent('yes');
    expect(screen.getByTestId('hasSignTx')).toHaveTextContent('yes');
  });
});
