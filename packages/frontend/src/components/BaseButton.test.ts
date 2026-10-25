import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import BaseButton from '@/components/BaseButton.vue';

// Tier 2, component: mount one component in a DOM and drive it like a user would.
function mountButton(props: { disabled?: boolean; loading?: boolean } = {}) {
  return mount(BaseButton, { props: { label: 'Pay', ...props } });
}

describe('BaseButton', () => {
  it('emits click when clicked', async () => {
    const wrapper = mountButton();
    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it.each([{ disabled: true }, { loading: true }])(
    'does not emit click when %o',
    async (props) => {
      const wrapper = mountButton(props);
      await wrapper.trigger('click');
      expect(wrapper.emitted('click')).toBeUndefined();
    },
  );

  it('shows the spinner instead of the label while loading', () => {
    const wrapper = mountButton({ loading: true });
    expect(wrapper.find('.btn__spinner').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Pay');
  });

  // A file snapshot pins the whole default markup; review the .snap diff on change.
  it('matches the default render snapshot', () => {
    expect(mountButton().html()).toMatchSnapshot();
  });

  // An inline snapshot keeps the expected markup next to the test that owns it.
  it('matches the loading render inline snapshot', () => {
    expect(mountButton({ loading: true }).html()).toMatchInlineSnapshot(
      `"<button data-v-2d3a2488="" class="btn btn--primary" disabled="" type="button"><span data-v-2d3a2488="" class="btn__spinner" aria-hidden="true"></span></button>"`,
    );
  });
});
