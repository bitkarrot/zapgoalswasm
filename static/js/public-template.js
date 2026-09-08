window.ZAPGOALS_PUBLIC_RENDER=function(){
const { resolveComponent: _resolveComponent, createVNode: _createVNode, createElementVNode: _createElementVNode, openBlock: _openBlock, createElementBlock: _createElementBlock, createCommentVNode: _createCommentVNode, toDisplayString: _toDisplayString, withCtx: _withCtx, createBlock: _createBlock, createTextVNode: _createTextVNode, renderList: _renderList, Fragment: _Fragment, withModifiers: _withModifiers } = Vue

return function render(_ctx, _cache) {
  const _component_q_btn = _resolveComponent("q-btn")
  const _component_q_spinner = _resolveComponent("q-spinner")
  const _component_q_icon = _resolveComponent("q-icon")
  const _component_q_card = _resolveComponent("q-card")
  const _component_q_badge = _resolveComponent("q-badge")
  const _component_q_card_section = _resolveComponent("q-card-section")
  const _component_q_avatar = _resolveComponent("q-avatar")
  const _component_q_space = _resolveComponent("q-space")
  const _component_q_input = _resolveComponent("q-input")
  const _component_q_dialog = _resolveComponent("q-dialog")
  const _component_qrcode_vue = _resolveComponent("qrcode-vue")
  const _component_q_spinner_dots = _resolveComponent("q-spinner-dots")

  return (_openBlock(), _createElementBlock("div", { class: "public-page row justify-center q-py-md q-py-sm-xl" }, [
    _createElementVNode("div", { class: "col-12 col-sm-9 col-md-7 col-lg-5" }, [
      _createElementVNode("div", { class: "row justify-end q-mb-sm" }, [
        _createVNode(_component_q_btn, {
          flat: "",
          round: "",
          dense: "",
          icon: _ctx.isDark?'light_mode':'dark_mode',
          "aria-label": "Toggle theme",
          onClick: _ctx.toggleTheme
        }, null, 8 /* PROPS */, ["icon", "onClick"])
      ]),
      (_ctx.loading)
        ? (_openBlock(), _createElementBlock("div", {
            key: 0,
            class: "text-center q-pa-xl"
          }, [
            _createVNode(_component_q_spinner, {
              color: "primary",
              size: "3rem"
            }),
            _createElementVNode("div", { class: "q-mt-md" }, "Loading goal…")
          ]))
        : (_ctx.loadError)
          ? (_openBlock(), _createBlock(_component_q_card, {
              key: 1,
              class: "q-pa-lg text-center"
            }, {
              default: _withCtx(() => [
                _createVNode(_component_q_icon, {
                  name: "error_outline",
                  color: "negative",
                  size: "3rem"
                }),
                _createElementVNode("div", { class: "text-h6 q-mt-md" }, _toDisplayString(_ctx.loadError), 1 /* TEXT */),
                _createVNode(_component_q_btn, {
                  outline: "",
                  color: "primary",
                  class: "q-mt-md",
                  label: "Retry",
                  onClick: $event => (_ctx.loadGoal())
                }, null, 8 /* PROPS */, ["onClick"])
              ]),
              _: 1 /* STABLE */
            }))
          : (_ctx.goal)
            ? (_openBlock(), _createBlock(_component_q_card, {
                key: 2,
                class: "public-card"
              }, {
                default: _withCtx(() => [
                  (_openBlock(), _createElementBlock("svg", {
                    class: "public-card-background",
                    viewBox: "0 0 100 100",
                    preserveAspectRatio: "none",
                    "aria-hidden": "true"
                  }, [
                    _createElementVNode("rect", {
                      x: "0",
                      y: "0",
                      width: "100",
                      height: "100",
                      fill: _ctx.goal.backgroundColor||'#FFFFFF'
                    }, null, 8 /* PROPS */, ["fill"])
                  ])),
                  _createVNode(_component_q_card_section, { class: "public-card-content q-pa-lg q-pa-sm-xl" }, {
                    default: _withCtx(() => [
                      _createElementVNode("h1", { class: "goal-title text-center q-mt-none q-mb-lg" }, _toDisplayString(_ctx.goal.title), 1 /* TEXT */),
                      (_ctx.goal.recurring)
                        ? (_openBlock(), _createElementBlock("div", {
                            key: 0,
                            class: "text-center q-mb-lg"
                          }, [
                            _createVNode(_component_q_badge, {
                              color: "primary",
                              class: "recurring-badge"
                            }, {
                              default: _withCtx(() => [
                                _createVNode(_component_q_icon, {
                                  name: "refresh",
                                  size: "14px",
                                  class: "q-mr-xs"
                                }),
                                _createTextVNode(_toDisplayString(_ctx.recurrenceLabel), 1 /* TEXT */)
                              ]),
                              _: 1 /* STABLE */
                            })
                          ]))
                        : _createCommentVNode("v-if", true),
                      (_ctx.goal.descriptionAbove)
                        ? (_openBlock(), _createElementBlock("p", {
                            key: 1,
                            class: "goal-description q-mb-lg"
                          }, _toDisplayString(_ctx.goal.descriptionAbove), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true),
                      _createElementVNode("div", {
                        class: "progress-wrap",
                        role: "progressbar",
                        "aria-label": 'Goal progress',
                        "aria-valuenow": _ctx.actualPercent,
                        "aria-valuemin": "0",
                        "aria-valuemax": Math.max(100,_ctx.actualPercent)
                      }, [
                        (_openBlock(), _createElementBlock("svg", {
                          class: "progress-svg",
                          viewBox: "0 0 100 12",
                          preserveAspectRatio: "none"
                        }, [
                          _createElementVNode("rect", {
                            x: "0",
                            y: "0",
                            width: "100",
                            height: "12",
                            rx: "6",
                            fill: _ctx.goal.remainderColor||'#E5E7EB'
                          }, null, 8 /* PROPS */, ["fill"]),
                          _createElementVNode("rect", {
                            x: "0",
                            y: "0",
                            width: _ctx.cappedPercent,
                            height: "12",
                            rx: "6",
                            fill: _ctx.goal.progressColor||'#F59E0B'
                          }, null, 8 /* PROPS */, ["width", "fill"])
                        ])),
                        _createElementVNode("span", { class: "percent-label" }, _toDisplayString(_ctx.percentLabel), 1 /* TEXT */)
                      ], 8 /* PROPS */, ["aria-valuenow", "aria-valuemax"]),
                      _createElementVNode("div", { class: "row justify-between q-mt-sm" }, [
                        _createElementVNode("span", null, "Current " + _toDisplayString(_ctx.formatSats(_ctx.goal.currentAmount)) + " sats", 1 /* TEXT */),
                        _createElementVNode("span", null, "Goal " + _toDisplayString(_ctx.formatSats(_ctx.goal.goalAmount)) + " sats", 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", { class: "goal-target text-center q-my-lg" }, [
                        _createVNode(_component_q_icon, { name: "event" }),
                        _createElementVNode("span", { class: "q-ml-xs" }, _toDisplayString(_ctx.targetLabel), 1 /* TEXT */),
                        _createElementVNode("div", { class: "text-weight-bold q-mt-xs" }, _toDisplayString(_ctx.countdownLabel), 1 /* TEXT */)
                      ]),
                      (_ctx.goal.descriptionBelow)
                        ? (_openBlock(), _createElementBlock("p", {
                            key: 2,
                            class: "goal-description q-mb-lg"
                          }, _toDisplayString(_ctx.goal.descriptionBelow), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true),
                      _createVNode(_component_q_btn, {
                        unelevated: "",
                        "no-caps": "",
                        size: "lg",
                        class: "full-width zap-action",
                        color: "primary",
                        icon: "bolt",
                        label: _ctx.zapButtonLabel,
                        disable: _ctx.isEnded || _ctx.creatingInvoice || _ctx.paymentState==='pending',
                        onClick: _ctx.openAmountDialog
                      }, null, 8 /* PROPS */, ["label", "disable", "onClick"]),
                      (_ctx.goal.legacyOpeningUnverified)
                        ? (_openBlock(), _createElementBlock("div", {
                            key: 3,
                            class: "text-caption q-mt-md",
                            role: "note"
                          }, "Includes an opening balance carried forward from an earlier version; it has not been independently reconciled."))
                        : _createCommentVNode("v-if", true),
                      (_ctx.isComplete && !_ctx.isEnded)
                        ? (_openBlock(), _createElementBlock("div", {
                            key: 4,
                            class: "paid-summary q-mt-lg",
                            "aria-live": "polite"
                          }, [
                            _createVNode(_component_q_icon, {
                              name: "check_circle",
                              color: "positive",
                              size: "2rem"
                            }),
                            _createElementVNode("span", null, _toDisplayString(_ctx.goal.recurring ? 'Period target reached — zaps remain open.' : 'Target reached — zaps remain open until the deadline.'), 1 /* TEXT */)
                          ]))
                        : _createCommentVNode("v-if", true)
                    ]),
                    _: 1 /* STABLE */
                  })
                ]),
                _: 1 /* STABLE */
              }))
            : _createCommentVNode("v-if", true)
    ]),
    _createVNode(_component_q_dialog, {
      modelValue: _ctx.amountDialog,
      "onUpdate:modelValue": [$event => ((_ctx.amountDialog) = $event), _ctx.onAmountDialogChange]
    }, {
      default: _withCtx(() => [
        _createVNode(_component_q_card, { class: "amount-dialog q-pa-lg" }, {
          default: _withCtx(() => [
            _createElementVNode("div", { class: "row items-center no-wrap q-mb-md" }, [
              _createVNode(_component_q_avatar, {
                size: "42px",
                color: "primary",
                "text-color": "white",
                icon: "bolt"
              }),
              _createElementVNode("div", { class: "text-h5 text-weight-bold q-ml-md" }, "Choose your zap"),
              _createVNode(_component_q_space),
              _createVNode(_component_q_btn, {
                flat: "",
                round: "",
                dense: "",
                icon: "close",
                "aria-label": "Close amount dialog",
                onClick: _ctx.closeAmountDialog
              }, null, 8 /* PROPS */, ["onClick"])
            ]),
            _createElementVNode("div", { class: "selected-amount text-center q-py-md" }, [
              _createElementVNode("div", { class: "selected-value text-weight-bold" }, _toDisplayString(_ctx.selectedAmountLabel), 1 /* TEXT */),
              _createElementVNode("div", { class: "text-h6" }, "sats")
            ]),
            _createElementVNode("div", { class: "text-body2 text-center text-grey-6 q-mb-md" }, "Select a suggested amount or enter your own."),
            _createElementVNode("div", { class: "row q-col-gutter-sm q-mb-lg" }, [
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.suggestedAmounts, (suggested) => {
                return (_openBlock(), _createElementBlock("div", {
                  key: suggested,
                  class: "col-6 col-sm-3"
                }, [
                  _createVNode(_component_q_btn, {
                    unelevated: "",
                    "no-caps": "",
                    class: "amount-option full-width",
                    outline: Number(_ctx.amount)!==Number(suggested),
                    color: Number(_ctx.amount)===Number(suggested)?'primary':_ctx.amountOptionColor,
                    label: _ctx.formatSats(suggested),
                    disable: _ctx.creatingInvoice,
                    onClick: $event => (_ctx.selectAmount(suggested))
                  }, null, 8 /* PROPS */, ["outline", "color", "label", "disable", "onClick"])
                ]))
              }), 128 /* KEYED_FRAGMENT */))
            ]),
            _createElementVNode("form", {
              class: "q-gutter-md",
              onSubmit: _withModifiers(_ctx.createInvoice, ["prevent"])
            }, [
              _createVNode(_component_q_input, {
                outlined: "",
                dense: "",
                type: "number",
                min: "1",
                max: "2100000000",
                step: "1",
                inputmode: "numeric",
                modelValue: _ctx.amount,
                "onUpdate:modelValue": $event => ((_ctx.amount) = $event),
                modelModifiers: { number: true },
                disable: _ctx.creatingInvoice,
                label: "Custom amount",
                suffix: "sats",
                rules: [_ctx.positiveAmount]
              }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "disable", "rules"]),
              _createVNode(_component_q_input, {
                outlined: "",
                type: "textarea",
                rows: "3",
                maxlength: "280",
                counter: "",
                modelValue: _ctx.comment,
                "onUpdate:modelValue": $event => ((_ctx.comment) = $event),
                disable: _ctx.creatingInvoice,
                label: "Comment (optional)"
              }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue", "disable"]),
              _createVNode(_component_q_btn, {
                unelevated: "",
                "no-caps": "",
                class: "zap-action full-width",
                color: "primary",
                icon: "bolt",
                type: "button",
                loading: _ctx.creatingInvoice,
                disable: _ctx.isEnded,
                label: _ctx.paymentButtonLabel,
                onClick: _ctx.createInvoice
              }, null, 8 /* PROPS */, ["loading", "disable", "label", "onClick"]),
              _createVNode(_component_q_btn, {
                flat: "",
                "no-caps": "",
                class: "full-width",
                type: "button",
                label: "Cancel",
                onClick: _ctx.closeAmountDialog
              }, null, 8 /* PROPS */, ["onClick"])
            ], 40 /* PROPS, NEED_HYDRATION */, ["onSubmit"])
          ]),
          _: 1 /* STABLE */
        })
      ]),
      _: 1 /* STABLE */
    }, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]),
    _createVNode(_component_q_dialog, {
      modelValue: _ctx.invoiceDialog,
      "onUpdate:modelValue": [$event => ((_ctx.invoiceDialog) = $event), _ctx.onInvoiceDialogChange],
      position: "top"
    }, {
      default: _withCtx(() => [
        _createVNode(_component_q_card, { class: "invoice-dialog q-pa-lg" }, {
          default: _withCtx(() => [
            (_ctx.invoice)
              ? (_openBlock(), _createElementBlock("div", { key: 0 }, [
                  _createElementVNode("div", { class: "text-h6 text-center" }, "Pay " + _toDisplayString(_ctx.formatSats(_ctx.invoice.amount)) + " sats", 1 /* TEXT */),
                  _createElementVNode("div", { class: "text-center text-grey-7 q-mb-md" }, "Scan the QR code with a Lightning wallet, or copy and paste the BOLT11 invoice into your wallet."),
                  _createElementVNode("div", { class: "qr-box" }, [
                    _createVNode(_component_qrcode_vue, {
                      value: 'LIGHTNING:'+_ctx.invoice.paymentRequest.toUpperCase(),
                      size: 240
                    }, null, 8 /* PROPS */, ["value"])
                  ]),
                  _createVNode(_component_q_input, {
                    outlined: "",
                    readonly: "",
                    type: "textarea",
                    autogrow: "",
                    "model-value": _ctx.invoice.paymentRequest,
                    label: "BOLT11 invoice"
                  }, {
                    append: _withCtx(() => [
                      _createVNode(_component_q_btn, {
                        flat: "",
                        round: "",
                        dense: "",
                        icon: "content_copy",
                        "aria-label": "Copy invoice",
                        onClick: _ctx.copyInvoice
                      }, null, 8 /* PROPS */, ["onClick"])
                    ]),
                    _: 1 /* STABLE */
                  }, 8 /* PROPS */, ["model-value"]),
                  (_ctx.monitoringError || _ctx.receiptError)
                    ? (_openBlock(), _createElementBlock("div", {
                        key: 0,
                        class: "q-mt-md",
                        role: "status"
                      }, [
                        (_ctx.monitoringError)
                          ? (_openBlock(), _createElementBlock("p", { key: 0 }, _toDisplayString(_ctx.monitoringError), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true),
                        (_ctx.receiptError)
                          ? (_openBlock(), _createElementBlock("p", { key: 1 }, _toDisplayString(_ctx.receiptError), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true),
                        _createVNode(_component_q_btn, {
                          outline: "",
                          color: "primary",
                          label: "Retry payment monitoring",
                          loading: _ctx.subscribing || Boolean(_ctx.receiptCheck),
                          onClick: _ctx.retryPaymentMonitoring
                        }, null, 8 /* PROPS */, ["loading", "onClick"])
                      ]))
                    : (_openBlock(), _createElementBlock("div", {
                        key: 1,
                        class: "pending-row",
                        "aria-live": "polite"
                      }, [
                        _createVNode(_component_q_spinner_dots, {
                          color: "primary",
                          size: "2rem"
                        }),
                        _createElementVNode("span", null, "Waiting for verified payment…"),
                        _createElementVNode("span", { class: "text-caption q-ml-sm" }, "The dialog closes automatically once the payment is confirmed.")
                      ])),
                  _createElementVNode("div", { class: "row justify-end q-mt-md" }, [
                    _createVNode(_component_q_btn, {
                      flat: "",
                      color: "grey",
                      label: "Close",
                      onClick: _ctx.closeInvoice
                    }, null, 8 /* PROPS */, ["onClick"])
                  ])
                ]))
              : _createCommentVNode("v-if", true)
          ]),
          _: 1 /* STABLE */
        })
      ]),
      _: 1 /* STABLE */
    }, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"])
  ]))
}
}
