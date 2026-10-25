import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import BaseModal from '@/components/BaseModal.vue';

// The modal teleports to <body>, so it is mounted into the real body and queried
// there; unmounting after each test removes the teleported markup again.
let unmount: (() => void) | undefined;

function mountModal(open: boolean) {
  const wrapper = mount(BaseModal, {
    props: { open, title: 'Cancel payment' },
    slots: { default: '<p class="body-text">Are you sure?</p>' },
    attachTo: document.body,
  });
  unmount = () => {
    wrapper.unmount();
  };
  return wrapper;
}

function byClass(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no element matches ${selector}`);
  return el;
}

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe('BaseModal', () => {
  it('renders nothing while closed', () => {
    mountModal(false);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders a dialog labelled by its title while open', () => {
    mountModal(true);
    expect(byClass('[role="dialog"]').getAttribute('aria-label')).toBe(
      'Cancel payment',
    );
  });

  it('emits close when the overlay itself is clicked', () => {
    const wrapper = mountModal(true);
    byClass('.modal-overlay').click();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not emit close when the dialog content is clicked', () => {
    const wrapper = mountModal(true);
    byClass('.body-text').click();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('emits close when the close button is clicked', () => {
    const wrapper = mountModal(true);
    byClass('.modal__close').click();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
