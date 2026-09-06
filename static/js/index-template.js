window.ZAPGOALS_INDEX_RENDER=function(){
const { createElementVNode: _createElementVNode, resolveComponent: _resolveComponent, createVNode: _createVNode, withCtx: _withCtx, toDisplayString: _toDisplayString, openBlock: _openBlock, createBlock: _createBlock, createCommentVNode: _createCommentVNode, createTextVNode: _createTextVNode, renderList: _renderList, Fragment: _Fragment, createElementBlock: _createElementBlock, withModifiers: _withModifiers } = Vue

return function render(_ctx, _cache) {
  const _component_q_btn = _resolveComponent("q-btn")
  const _component_q_card_section = _resolveComponent("q-card-section")
  const _component_q_separator = _resolveComponent("q-separator")
  const _component_q_icon = _resolveComponent("q-icon")
  const _component_q_badge = _resolveComponent("q-badge")
  const _component_q_td = _resolveComponent("q-td")
  const _component_q_tooltip = _resolveComponent("q-tooltip")
  const _component_q_card_actions = _resolveComponent("q-card-actions")
  const _component_q_card = _resolveComponent("q-card")
  const _component_q_table = _resolveComponent("q-table")
  const _component_q_expansion_item = _resolveComponent("q-expansion-item")
  const _component_q_list = _resolveComponent("q-list")
  const _component_q_space = _resolveComponent("q-space")
  const _component_q_input = _resolveComponent("q-input")
  const _component_q_select = _resolveComponent("q-select")
  const _component_q_banner = _resolveComponent("q-banner")
  const _component_q_dialog = _resolveComponent("q-dialog")

  return (_openBlock(), _createElementBlock("div", { class: "row q-col-gutter-md page-wrap" }, [
    _createElementVNode("div", { class: "col-12 col-lg-9" }, [
      _createVNode(_component_q_card, null, {
        default: _withCtx(() => [
          _createVNode(_component_q_card_section, { class: "row items-center" }, {
            default: _withCtx(() => [
              _createElementVNode("div", { class: "col" }, [
                _createElementVNode("div", { class: "text-h5" }, "ZapGoals"),
                _createElementVNode("div", { class: "text-body2 text-grey-6" }, "Create and share Lightning fundraising goals.")
              ]),
              _createVNode(_component_q_btn, {
                flat: "",
                round: "",
                dense: "",
                icon: _ctx.isDark ? 'light_mode' : 'dark_mode',
                "aria-label": "Toggle theme",
                onClick: _ctx.toggleTheme
              }, null, 8 /* PROPS */, ["icon", "onClick"]),
              _createVNode(_component_q_btn, {
                unelevated: "",
                color: "primary",
                icon: "add",
                label: "New goal",
                onClick: $event => (_ctx.openGoalDialog())
              }, null, 8 /* PROPS */, ["onClick"])
            ]),
            _: 1 /* STABLE */
          }),
          _createVNode(_component_q_separator),
          (_ctx.loadError && !_ctx.loading)
            ? (_openBlock(), _createBlock(_component_q_card_section, {
                key: 0,
                class: "text-center q-pa-xl"
              }, {
                default: _withCtx(() => [
                  _createVNode(_component_q_icon, {
                    name: "error_outline",
                    color: "negative",
                    size: "3rem"
                  }),
                  _createElementVNode("div", { class: "q-my-md" }, _toDisplayString(_ctx.loadError), 1 /* TEXT */),
                  _createVNode(_component_q_btn, {
                    outline: "",
                    color: "primary",
                    label: "Retry",
                    onClick: _ctx.load
                  }, null, 8 /* PROPS */, ["onClick"])
                ]),
                _: 1 /* STABLE */
              }))
            : (!_ctx.loading && !_ctx.goals.length)
              ? (_openBlock(), _createBlock(_component_q_card_section, {
                  key: 1,
                  class: "text-center q-pa-xl"
                }, {
                  default: _withCtx(() => [
                    _createVNode(_component_q_icon, {
                      name: "flag",
                      color: "grey-5",
                      size: "3rem"
                    }),
                    _createElementVNode("div", { class: "text-h6 q-mt-md" }, "No goals yet"),
                    _createElementVNode("div", { class: "text-body2 text-grey-6" }, "Create your first goal to get a public fundraising page.")
                  ]),
                  _: 1 /* STABLE */
                }))
              : (_openBlock(), _createBlock(_component_q_table, {
                  key: 2,
                  flat: "",
                  grid: _ctx.$q.screen.lt.md,
                  rows: _ctx.goals,
                  columns: _ctx.columns,
                  "row-key": "id",
                  loading: _ctx.loading,
                  pagination: {rowsPerPage:10}
                }, {
                  "body-cell-status": _withCtx((props) => [
                    _createVNode(_component_q_td, { props: props }, {
                      default: _withCtx(() => [
                        _createVNode(_component_q_badge, {
                          color: _ctx.goalStatus(props.row)==='Active'?'positive':'grey',
                          label: _ctx.goalStatus(props.row)
                        }, null, 8 /* PROPS */, ["color", "label"])
                      ]),
                      _: 2 /* DYNAMIC */
                    }, 1032 /* PROPS, DYNAMIC_SLOTS */, ["props"])
                  ]),
                  "body-cell-actions": _withCtx((props) => [
                    _createVNode(_component_q_td, {
                      props: props,
                      class: "q-gutter-xs"
                    }, {
                      default: _withCtx(() => [
                        _createVNode(_component_q_btn, {
                          flat: "",
                          round: "",
                          dense: "",
                          icon: "content_copy",
                          "aria-label": "Copy public link",
                          onClick: $event => (_ctx.copyPublicUrl(props.row))
                        }, {
                          default: _withCtx(() => [
                            _createVNode(_component_q_tooltip, null, {
                              default: _withCtx(() => [
                                _createTextVNode("Copy public link")
                              ]),
                              _: 1 /* STABLE */
                            })
                          ]),
                          _: 1 /* STABLE */
                        }, 8 /* PROPS */, ["onClick"]),
                        _createVNode(_component_q_btn, {
                          flat: "",
                          round: "",
                          dense: "",
                          icon: "open_in_new",
                          "aria-label": "Open public page",
                          onClick: $event => (_ctx.openPublic(props.row))
                        }, {
                          default: _withCtx(() => [
                            _createVNode(_component_q_tooltip, null, {
                              default: _withCtx(() => [
                                _createTextVNode("Open public page")
                              ]),
                              _: 1 /* STABLE */
                            })
                          ]),
                          _: 1 /* STABLE */
                        }, 8 /* PROPS */, ["onClick"]),
                        _createVNode(_component_q_btn, {
                          flat: "",
                          round: "",
                          dense: "",
                          color: "primary",
                          icon: "edit",
                          "aria-label": "Edit goal",
                          onClick: $event => (_ctx.openGoalDialog(props.row))
                        }, null, 8 /* PROPS */, ["onClick"]),
                        _createVNode(_component_q_btn, {
                          flat: "",
                          round: "",
                          dense: "",
                          color: "negative",
                          icon: "delete",
                          "aria-label": "Delete goal",
                          onClick: $event => (_ctx.confirmDelete(props.row))
                        }, null, 8 /* PROPS */, ["onClick"])
                      ]),
                      _: 2 /* DYNAMIC */
                    }, 1032 /* PROPS, DYNAMIC_SLOTS */, ["props"])
                  ]),
                  item: _withCtx((props) => [
                    _createElementVNode("div", { class: "q-pa-xs col-12 col-sm-6" }, [
                      _createVNode(_component_q_card, {
                        flat: "",
                        bordered: ""
                      }, {
                        default: _withCtx(() => [
                          _createVNode(_component_q_card_section, null, {
                            default: _withCtx(() => [
                              _createElementVNode("div", { class: "row items-start no-wrap" }, [
                                _createElementVNode("div", { class: "col" }, [
                                  _createElementVNode("div", { class: "text-h6" }, _toDisplayString(props.row.title), 1 /* TEXT */),
                                  _createElementVNode("div", null, _toDisplayString(_ctx.formatSats(props.row.currentAmount)) + " / " + _toDisplayString(_ctx.formatSats(props.row.goalAmount)), 1 /* TEXT */),
                                  _createElementVNode("div", { class: "text-caption text-grey-6" }, _toDisplayString(_ctx.formatDate(props.row.targetDate)), 1 /* TEXT */)
                                ]),
                                _createVNode(_component_q_badge, {
                                  color: _ctx.goalStatus(props.row)==='Active'?'positive':'grey',
                                  label: _ctx.goalStatus(props.row)
                                }, null, 8 /* PROPS */, ["color", "label"])
                              ])
                            ]),
                            _: 2 /* DYNAMIC */
                          }, 1024 /* DYNAMIC_SLOTS */),
                          _createVNode(_component_q_card_actions, { align: "right" }, {
                            default: _withCtx(() => [
                              _createVNode(_component_q_btn, {
                                flat: "",
                                round: "",
                                icon: "content_copy",
                                onClick: $event => (_ctx.copyPublicUrl(props.row))
                              }, null, 8 /* PROPS */, ["onClick"]),
                              _createVNode(_component_q_btn, {
                                flat: "",
                                round: "",
                                icon: "open_in_new",
                                onClick: $event => (_ctx.openPublic(props.row))
                              }, null, 8 /* PROPS */, ["onClick"]),
                              _createVNode(_component_q_btn, {
                                flat: "",
                                round: "",
                                color: "primary",
                                icon: "edit",
                                onClick: $event => (_ctx.openGoalDialog(props.row))
                              }, null, 8 /* PROPS */, ["onClick"]),
                              _createVNode(_component_q_btn, {
                                flat: "",
                                round: "",
                                color: "negative",
                                icon: "delete",
                                onClick: $event => (_ctx.confirmDelete(props.row))
                              }, null, 8 /* PROPS */, ["onClick"])
                            ]),
                            _: 2 /* DYNAMIC */
                          }, 1024 /* DYNAMIC_SLOTS */)
                        ]),
                        _: 2 /* DYNAMIC */
                      }, 1024 /* DYNAMIC_SLOTS */)
                    ])
                  ]),
                  _: 1 /* STABLE */
                }, 8 /* PROPS */, ["grid", "rows", "columns", "loading"]))
        ]),
        _: 1 /* STABLE */
      })
    ]),
    _createElementVNode("div", { class: "col-12 col-lg-3" }, [
      _createVNode(_component_q_card, null, {
        default: _withCtx(() => [
          _createVNode(_component_q_card_section, null, {
            default: _withCtx(() => [
              _createElementVNode("div", { class: "text-h6" }, "About ZapGoals"),
              _createElementVNode("p", null, "Build a shareable goal, track incoming sats live and let supporters pay with any Lightning wallet."),
              _createVNode(_component_q_list, {
                bordered: "",
                separator: "",
                class: "rounded-borders q-mb-md"
              }, {
                default: _withCtx(() => [
                  _createVNode(_component_q_expansion_item, {
                    dense: "",
                    icon: "link",
                    label: "Direct LNURL-pay"
                  }, {
                    default: _withCtx(() => [
                      _createElementVNode("div", { class: "q-pa-md text-body2" }, "Each goal exposes a direct LNURL-pay endpoint for compatible wallets.")
                    ]),
                    _: 1 /* STABLE */
                  }),
                  _createVNode(_component_q_expansion_item, {
                    dense: "",
                    icon: "security",
                    label: "WASM limitations"
                  }, {
                    default: _withCtx(() => [
                      _createElementVNode("div", { class: "q-pa-md text-body2" }, "Lightning Address routing and NIP-57 receipt signing are not exposed by the current WASM host.")
                    ]),
                    _: 1 /* STABLE */
                  })
                ]),
                _: 1 /* STABLE */
              }),
              _createElementVNode("div", { class: "text-caption" }, "Created by bitkarrot")
            ]),
            _: 1 /* STABLE */
          })
        ]),
        _: 1 /* STABLE */
      })
    ]),
    _createVNode(_component_q_dialog, {
      modelValue: _ctx.formDialog.show,
      "onUpdate:modelValue": $event => ((_ctx.formDialog.show) = $event),
      position: "top",
      onHide: _ctx.resetDialog
    }, {
      default: _withCtx(() => [
        _createVNode(_component_q_card, { class: "goal-dialog q-pa-md" }, {
          default: _withCtx(() => [
            _createVNode(_component_q_card_section, { class: "row items-center q-pb-none" }, {
              default: _withCtx(() => [
                _createElementVNode("div", { class: "text-h6" }, _toDisplayString(_ctx.formDialog.editing?'Edit goal':'New goal'), 1 /* TEXT */),
                _createVNode(_component_q_space),
                _createVNode(_component_q_btn, {
                  flat: "",
                  round: "",
                  dense: "",
                  icon: "close",
                  "aria-label": "Close dialog",
                  onClick: _ctx.closeGoalDialog
                }, null, 8 /* PROPS */, ["onClick"])
              ]),
              _: 1 /* STABLE */
            }),
            _createVNode(_component_q_card_section, null, {
              default: _withCtx(() => [
                _createElementVNode("form", {
                  class: "q-gutter-md",
                  onSubmit: _withModifiers(_ctx.saveGoal, ["prevent"])
                }, [
                  _createElementVNode("div", { class: "row q-col-gutter-md" }, [
                    _createElementVNode("div", { class: "col-12 col-sm-7" }, [
                      _createVNode(_component_q_input, {
                        filled: "",
                        modelValue: _ctx.formDialog.data.title,
                        "onUpdate:modelValue": $event => ((_ctx.formDialog.data.title) = $event),
                        label: "Title *",
                        maxlength: "120",
                        counter: "",
                        rules: [_ctx.requiredTitle]
                      }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "rules"])
                    ]),
                    _createElementVNode("div", { class: "col-12 col-sm-5" }, [
                      _createVNode(_component_q_select, {
                        filled: "",
                        "emit-value": "",
                        "map-options": "",
                        modelValue: _ctx.formDialog.data.walletId,
                        "onUpdate:modelValue": $event => ((_ctx.formDialog.data.walletId) = $event),
                        options: _ctx.walletOptions,
                        label: "Wallet *",
                        disable: _ctx.formDialog.editing,
                        rules: [_ctx.required]
                      }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "options", "disable", "rules"])
                    ])
                  ]),
                  _createVNode(_component_q_input, {
                    filled: "",
                    type: "textarea",
                    autogrow: "",
                    modelValue: _ctx.formDialog.data.descriptionAbove,
                    "onUpdate:modelValue": $event => ((_ctx.formDialog.data.descriptionAbove) = $event),
                    label: "Text above the progress bar",
                    maxlength: "2000",
                    counter: ""
                  }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]),
                  _createElementVNode("div", { class: "row q-col-gutter-md" }, [
                    _createElementVNode("div", { class: "col-12 col-sm-6" }, [
                      _createVNode(_component_q_input, {
                        filled: "",
                        type: "number",
                        min: "1",
                        step: "1",
                        modelValue: _ctx.formDialog.data.goalAmount,
                        "onUpdate:modelValue": $event => ((_ctx.formDialog.data.goalAmount) = $event),
                        modelModifiers: { number: true },
                        label: "Goal amount *",
                        suffix: "sats",
                        rules: [_ctx.positiveAmount]
                      }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "rules"])
                    ]),
                    _createElementVNode("div", { class: "col-12 col-sm-6" }, [
                      _createVNode(_component_q_input, {
                        filled: "",
                        type: "datetime-local",
                        modelValue: _ctx.formDialog.data.targetDate,
                        "onUpdate:modelValue": $event => ((_ctx.formDialog.data.targetDate) = $event),
                        label: "Target date *",
                        "stack-label": "",
                        rules: [_ctx.required]
                      }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "rules"])
                    ])
                  ]),
                  _createElementVNode("div", { class: "suggested-section q-mb-lg" }, [
                    _createElementVNode("div", { class: "text-subtitle2" }, "Suggested zap amounts"),
                    _createElementVNode("div", { class: "text-caption text-grey-6 q-mb-sm" }, "Configure between one and four unique amounts. Leave unused fields blank."),
                    _createElementVNode("div", { class: "row q-col-gutter-sm" }, [
                      (_openBlock(), _createElementBlock(_Fragment, null, _renderList(4, (index) => {
                        return _createElementVNode("div", {
                          key: index,
                          class: "col-6 col-sm-3"
                        }, [
                          _createVNode(_component_q_input, {
                            filled: "",
                            type: "number",
                            min: "1",
                            max: "2100000000",
                            step: "1",
                            modelValue: _ctx.formDialog.data.suggestedAmounts[index-1],
                            "onUpdate:modelValue": $event => ((_ctx.formDialog.data.suggestedAmounts[index-1]) = $event),
                            modelModifiers: { number: true },
                            label: `Amount ${index}`,
                            suffix: "sats"
                          }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "label"])
                        ])
                      }), 64 /* STABLE_FRAGMENT */))
                    ])
                  ]),
                  _createVNode(_component_q_separator, { class: "q-my-md" }),
                  _createElementVNode("div", { class: "section-heading" }, [
                    _createElementVNode("div", { class: "text-subtitle1 text-weight-bold" }, "Payment settings"),
                    _createElementVNode("div", { class: "text-caption text-grey-6" }, "Choose how contributors are offered wallet payment options.")
                  ]),
                  _createVNode(_component_q_select, {
                    class: "full-width",
                    filled: "",
                    "emit-value": "",
                    "map-options": "",
                    modelValue: _ctx.formDialog.data.walletMode,
                    "onUpdate:modelValue": $event => ((_ctx.formDialog.data.walletMode) = $event),
                    options: _ctx.modeOptions,
                    label: "Wallet payment mode"
                  }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "options"]),
                  _createVNode(_component_q_banner, {
                    rounded: "",
                    class: "info-banner"
                  }, {
                    default: _withCtx(() => [
                      _createVNode(_component_q_icon, {
                        name: "qr_code",
                        class: "q-mr-sm"
                      }),
                      _createTextVNode("A standard BOLT11 invoice and QR code are always available. Bitcoin Connect is an additional option.")
                    ]),
                    _: 1 /* STABLE */
                  }),
                  _createVNode(_component_q_input, {
                    filled: "",
                    modelValue: _ctx.formDialog.data.nostrPubkey,
                    "onUpdate:modelValue": $event => ((_ctx.formDialog.data.nostrPubkey) = $event),
                    modelModifiers: { trim: true },
                    label: "Nostr recipient public key (metadata only)",
                    maxlength: "64",
                    hint: "NIP-57 signing is unavailable in WASM.",
                    rules: [_ctx.validNostr]
                  }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "rules"]),
                  _createVNode(_component_q_input, {
                    filled: "",
                    modelValue: _ctx.formDialog.data.lightningAddressUsername,
                    "onUpdate:modelValue": $event => ((_ctx.formDialog.data.lightningAddressUsername) = $event),
                    modelModifiers: { trim: true },
                    label: "Lightning Address username (metadata only)",
                    maxlength: "64",
                    hint: "The WASM extension cannot own /.well-known/lnurlp.",
                    rules: [_ctx.validUsername]
                  }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "rules"]),
                  _createVNode(_component_q_input, {
                    filled: "",
                    type: "textarea",
                    autogrow: "",
                    modelValue: _ctx.formDialog.data.descriptionBelow,
                    "onUpdate:modelValue": $event => ((_ctx.formDialog.data.descriptionBelow) = $event),
                    label: "Text below the progress bar",
                    maxlength: "2000",
                    counter: ""
                  }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]),
                  _createVNode(_component_q_separator, { class: "q-my-md" }),
                  _createElementVNode("div", { class: "section-heading" }, [
                    _createElementVNode("div", { class: "text-subtitle1 text-weight-bold" }, "Design"),
                    _createElementVNode("div", { class: "text-caption text-grey-6" }, "Customize the public goal appearance and preview it below.")
                  ]),
                  _createElementVNode("div", { class: "design-color-grid" }, [
                    _createVNode(_component_q_input, {
                      class: "design-color-field",
                      filled: "",
                      type: "color",
                      modelValue: _ctx.formDialog.data.backgroundColor,
                      "onUpdate:modelValue": $event => ((_ctx.formDialog.data.backgroundColor) = $event),
                      label: "Background",
                      "stack-label": ""
                    }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]),
                    _createVNode(_component_q_input, {
                      class: "design-color-field",
                      filled: "",
                      type: "color",
                      modelValue: _ctx.formDialog.data.textColor,
                      "onUpdate:modelValue": $event => ((_ctx.formDialog.data.textColor) = $event),
                      label: "Text",
                      "stack-label": ""
                    }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]),
                    _createVNode(_component_q_input, {
                      class: "design-color-field",
                      filled: "",
                      type: "color",
                      modelValue: _ctx.formDialog.data.progressColor,
                      "onUpdate:modelValue": $event => ((_ctx.formDialog.data.progressColor) = $event),
                      label: "Progress",
                      "stack-label": ""
                    }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]),
                    _createVNode(_component_q_input, {
                      class: "design-color-field",
                      filled: "",
                      type: "color",
                      modelValue: _ctx.formDialog.data.remainderColor,
                      "onUpdate:modelValue": $event => ((_ctx.formDialog.data.remainderColor) = $event),
                      label: "Remainder",
                      "stack-label": ""
                    }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"])
                  ]),
                  _createElementVNode("div", { class: "row q-col-gutter-md" }, [
                    _createElementVNode("div", { class: "col-12 col-sm-8" }, [
                      _createVNode(_component_q_select, {
                        filled: "",
                        "emit-value": "",
                        "map-options": "",
                        modelValue: _ctx.formDialog.data.fontName,
                        "onUpdate:modelValue": $event => ((_ctx.formDialog.data.fontName) = $event),
                        options: _ctx.fontOptions,
                        label: "Font family"
                      }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "options"])
                    ]),
                    _createElementVNode("div", { class: "col-12 col-sm-4" }, [
                      _createVNode(_component_q_select, {
                        filled: "",
                        "emit-value": "",
                        "map-options": "",
                        modelValue: _ctx.formDialog.data.fontWeight,
                        "onUpdate:modelValue": $event => ((_ctx.formDialog.data.fontWeight) = $event),
                        options: _ctx.fontWeightOptions,
                        label: "Font weight"
                      }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "options"])
                    ])
                  ]),
                  _createElementVNode("div", { class: "text-subtitle2 q-mt-md" }, "Live preview"),
                  _createElementVNode("div", { class: "goal-preview rounded-borders" }, [
                    (_openBlock(), _createElementBlock("svg", {
                      class: "goal-preview-svg",
                      viewBox: "0 0 700 180",
                      role: "img",
                      "aria-label": "Goal design preview"
                    }, [
                      _createElementVNode("rect", {
                        class: "preview-background",
                        x: "0",
                        y: "0",
                        width: "700",
                        height: "180",
                        rx: "14",
                        fill: _ctx.formDialog.data.backgroundColor
                      }, null, 8 /* PROPS */, ["fill"]),
                      _createElementVNode("text", {
                        class: "preview-title",
                        x: "24",
                        y: "42",
                        fill: _ctx.formDialog.data.textColor,
                        "font-family": _ctx.formDialog.data.fontName,
                        "font-weight": _ctx.formDialog.data.fontWeight,
                        "font-size": "24"
                      }, _toDisplayString(_ctx.formDialog.data.title||'Your goal title'), 9 /* TEXT, PROPS */, ["fill", "font-family", "font-weight"]),
                      _createElementVNode("rect", {
                        x: "24",
                        y: "76",
                        width: "652",
                        height: "42",
                        rx: "21",
                        fill: _ctx.formDialog.data.remainderColor
                      }, null, 8 /* PROPS */, ["fill"]),
                      _createElementVNode("rect", {
                        x: "24",
                        y: "76",
                        width: _ctx.previewBarWidth,
                        height: "42",
                        rx: "21",
                        fill: _ctx.formDialog.data.progressColor
                      }, null, 8 /* PROPS */, ["width", "fill"]),
                      _createElementVNode("text", {
                        class: "preview-percent",
                        x: "350",
                        y: "103",
                        "text-anchor": "middle",
                        fill: _ctx.formDialog.data.textColor,
                        "font-family": _ctx.formDialog.data.fontName,
                        "font-weight": _ctx.formDialog.data.fontWeight,
                        "font-size": "18"
                      }, _toDisplayString(_ctx.previewPercent.toFixed(1)) + "%", 9 /* TEXT, PROPS */, ["fill", "font-family", "font-weight"]),
                      _createElementVNode("text", {
                        x: "24",
                        y: "151",
                        fill: _ctx.formDialog.data.textColor,
                        "font-family": _ctx.formDialog.data.fontName,
                        "font-weight": _ctx.formDialog.data.fontWeight,
                        "font-size": "17"
                      }, "Current " + _toDisplayString(Number(_ctx.formDialog.data.currentAmount||0).toLocaleString()) + " sats", 9 /* TEXT, PROPS */, ["fill", "font-family", "font-weight"]),
                      _createElementVNode("text", {
                        x: "676",
                        y: "151",
                        "text-anchor": "end",
                        fill: _ctx.formDialog.data.textColor,
                        "font-family": _ctx.formDialog.data.fontName,
                        "font-weight": _ctx.formDialog.data.fontWeight,
                        "font-size": "17"
                      }, "Goal " + _toDisplayString(Number(_ctx.formDialog.data.goalAmount||0).toLocaleString()) + " sats", 9 /* TEXT, PROPS */, ["fill", "font-family", "font-weight"])
                    ]))
                  ]),
                  (_ctx.formError)
                    ? (_openBlock(), _createElementBlock("div", {
                        key: 0,
                        class: "text-negative",
                        role: "alert"
                      }, _toDisplayString(_ctx.formError), 1 /* TEXT */))
                    : _createCommentVNode("v-if", true),
                  _createElementVNode("div", { class: "row justify-end q-gutter-sm" }, [
                    _createVNode(_component_q_btn, {
                      flat: "",
                      label: "Cancel",
                      type: "button",
                      onClick: _ctx.closeGoalDialog
                    }, null, 8 /* PROPS */, ["onClick"]),
                    _createVNode(_component_q_btn, {
                      unelevated: "",
                      color: "primary",
                      type: "button",
                      loading: _ctx.saving,
                      label: "Save goal",
                      onClick: _ctx.saveGoal
                    }, null, 8 /* PROPS */, ["loading", "onClick"])
                  ])
                ], 40 /* PROPS, NEED_HYDRATION */, ["onSubmit"])
              ]),
              _: 1 /* STABLE */
            })
          ]),
          _: 1 /* STABLE */
        })
      ]),
      _: 1 /* STABLE */
    }, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "onHide"]),
    _createVNode(_component_q_dialog, {
      modelValue: _ctx.deleteDialog.show,
      "onUpdate:modelValue": $event => ((_ctx.deleteDialog.show) = $event)
    }, {
      default: _withCtx(() => [
        _createVNode(_component_q_card, { class: "confirm-dialog q-pa-md" }, {
          default: _withCtx(() => [
            _createVNode(_component_q_card_section, null, {
              default: _withCtx(() => [
                _createElementVNode("div", { class: "text-h6" }, "Delete goal"),
                _createElementVNode("p", null, "Delete “" + _toDisplayString(_ctx.deleteDialog.goal?.title) + "”? This cannot be undone.", 1 /* TEXT */)
              ]),
              _: 1 /* STABLE */
            }),
            _createVNode(_component_q_card_actions, { align: "right" }, {
              default: _withCtx(() => [
                _createVNode(_component_q_btn, {
                  flat: "",
                  label: "Cancel",
                  onClick: $event => (_ctx.deleteDialog.show=false)
                }, null, 8 /* PROPS */, ["onClick"]),
                _createVNode(_component_q_btn, {
                  unelevated: "",
                  color: "negative",
                  label: "Delete",
                  loading: _ctx.deleteDialog.loading,
                  onClick: _ctx.deleteGoal
                }, null, 8 /* PROPS */, ["loading", "onClick"])
              ]),
              _: 1 /* STABLE */
            })
          ]),
          _: 1 /* STABLE */
        })
      ]),
      _: 1 /* STABLE */
    }, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"])
  ]))
}
}
