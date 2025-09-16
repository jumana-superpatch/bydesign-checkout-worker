export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "*",
				},
			});
		}

		try {
			const url = new URL(request.url);
			console.log(url.pathname);
			if (url.pathname === "/lookup-checkout") {
				const email = url.searchParams.get("email");
				if (!email) {
					return jsonResponse({ did: null, error: "Missing email" }, 400);
				}

				console.log(`Looking up email: ${email}`);

				// 1. Check Shopify
				const shopifyCustomer = await findCustomerInShopify(
					email,
					env.SHOPIFY_SHOP,
					env.SHAPETECH_ADMIN_API_KEY
				);

				if (shopifyCustomer) {
					const did =
						shopifyCustomer.metafields?.edges?.find(
							(edge) =>
								edge.node.namespace === "external" &&
								edge.node.key === "bydesign_id"
						)?.node.value || null;

					return jsonResponse({ did });
				}

				// 2. Check ByDesign
				const byDesignCustomer = await findCustomerInByDesign(
					email,
					env.BYDESIGN_BASE,
					env.BYDESIGN_API_KEY
				);

				if (byDesignCustomer) {
					const createdCustomer = await createCustomerInShopify(
						byDesignCustomer,
						env.SHOPIFY_SHOP,
						env.SHAPETECH_ADMIN_API_KEY
					);

					if (
						byDesignCustomer.ShipStreet1 &&
						byDesignCustomer.ShipCity &&
						byDesignCustomer.ShipState &&
						byDesignCustomer.ShipCountry &&
						byDesignCustomer.ShipPostalCode
					) {
						await createCustomerAddressInShopify(
							createdCustomer.id,
							byDesignCustomer,
							env.SHOPIFY_SHOP,
							env.SHAPETECH_ADMIN_API_KEY
						);
					}

					return jsonResponse({
						did: String(byDesignCustomer.CustomerDID || ""),
					});
				}

				return jsonResponse({ did: null });
			}
			// === CASE 3: CUSTOMER → REP LOOKUP FLOW ===

			// if (url.pathname === "/lookup-checkout") {
			// 	const email = url.searchParams.get("email");
			// 	if (!email) {
			// 		return jsonResponse({ error: "Missing email" }, 400);
			// 	}

			// 	try {
			// 		// 1. Customer lookup
			// 		const custResp = await fetch(
			// 			`${env.BYDESIGN_BASE}/VoxxLife/api/users/customer/CustomerLookup?email=${encodeURIComponent(email)}`,
			// 			{
			// 				headers: {
			// 					Authorization: `Basic ${env.BYDESIGN_API_KEY}`,
			// 					Accept: "application/json",
			// 				},
			// 			}
			// 		);

			// 		if (!custResp.ok) {
			// 			return jsonResponse({ error: "Customer lookup failed" }, 404);
			// 		}

			// 		const custData = await custResp.json();
			// 		const customerDID = custData?.CustomerDID;
			// 		if (!customerDID) {
			// 			return jsonResponse({ error: "Customer not found" }, 404);
			// 		}

			// 		// 2. Get RepDID for customer
			// 		const repLinkResp = await fetch(
			// 			`${env.BYDESIGN_BASE}/VoxxLife/api/rep/PublicInfo/GetForCustomer/${encodeURIComponent(customerDID)}`,
			// 			{
			// 				headers: {
			// 					Authorization: `Basic ${env.BYDESIGN_API_KEY}`,
			// 					Accept: "application/json",
			// 				},
			// 			}
			// 		);

			// 		let repDID = null;
			// 		if (repLinkResp.ok) {
			// 			const repLink = await repLinkResp.json();
			// 			repDID = repLink?.RepDID;
			// 		}

			// 		// 3. Get Rep info (if RepDID found)
			// 		let repData = {};
			// 		if (repDID) {
			// 			const repInfoResp = await fetch(
			// 				`${env.BYDESIGN_BASE}/VoxxLife/api/User/Rep/${encodeURIComponent(repDID)}/info`,
			// 				{
			// 					headers: {
			// 						Authorization: `Basic ${env.BYDESIGN_API_KEY}`,
			// 						Accept: "application/json",
			// 					},
			// 				}
			// 			);
			// 			if (repInfoResp.ok) {
			// 				repData = await repInfoResp.json();
			// 			}
			// 		}

			// 		return jsonResponse({
			// 			customer: {
			// 				did: customerDID,
			// 				email: custData?.Email || email,
			// 			},
			// 			rep: {
			// 				did: repDID || null,
			// 				email: repData?.Email || null,
			// 				firstName: repData?.FirstName || null,
			// 				lastName: repData?.LastName || null,
			// 			},
			// 		});
			// 	} catch (err) {
			// 		console.error("Customer→Rep flow failed:", err);
			// 		return jsonResponse({ error: err.message }, 500);
			// 	}
			// }


			// Unknown endpoint
			return jsonResponse({ error: "Unknown endpoint" }, 404);
		} catch (err) {
			console.error("Worker error:", err.message);
			return jsonResponse({ error: err.message }, 500);
		}
	},
};

// ---------- Helpers ----------
function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}


async function findCustomerInShopify(email, shop, token) {
	const query = `
    query customersByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            email
            metafields(namespace: "external", first: 5) {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

	const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Shopify-Access-Token": token,
		},
		body: JSON.stringify({ query, variables: { query: `email:${email}` } }),
	});

	if (!res.ok) throw new Error(`Shopify lookup failed: ${res.status}`);

	const json = await res.json();
	return json.data?.customers?.edges?.[0]?.node || null;
}

async function findCustomerInByDesign(email, base, apiKey) {
	const res = await fetch(`${base}/VoxxLife/api/users/customer/CustomerLookup`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Basic ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ Email: email }),
	});

	if (!res.ok) return null;

	const data = await res.json();
	if (Array.isArray(data) && data.length > 0) {
		return data.find((c) => c.Email?.toLowerCase() === email.toLowerCase()) || null;
	}
	return null;
}

async function createCustomerInShopify(customer, shop, token) {
	const mutation = `
    mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          firstName
          lastName
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

	const input = {
		email: customer.Email,
		firstName: customer.FirstName || "",
		lastName: customer.LastName || "",
		metafields: [
			{
				namespace: "external",
				key: "bydesign_id",
				type: "single_line_text_field",
				value: String(customer.CustomerDID || ""),
			},
		],
	};

	const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Shopify-Access-Token": token,
		},
		body: JSON.stringify({ query: mutation, variables: { input } }),
	});

	const json = await res.json();
	if (json.data?.customerCreate?.userErrors?.length) {
		throw new Error(JSON.stringify(json.data.customerCreate.userErrors));
	}

	return json.data?.customerCreate?.customer || null;
}

async function createCustomerAddressInShopify(customerId, byDesignCustomer, shop, token) {
	const mutation = `
    mutation customerAddressCreate($customerId: ID!, $address: MailingAddressInput!) {
      customerAddressCreate(customerId: $customerId, address: $address) {
        customerAddress {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

	const address = {
		address1: byDesignCustomer.ShipStreet1,
		city: byDesignCustomer.ShipCity,
		province: byDesignCustomer.ShipState,
		country: byDesignCustomer.ShipCountry,
		zip: byDesignCustomer.ShipPostalCode,
		firstName: byDesignCustomer.FirstName,
		lastName: byDesignCustomer.LastName,
	};

	const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Shopify-Access-Token": token,
		},
		body: JSON.stringify({ query: mutation, variables: { customerId, address } }),
	});

	const json = await res.json();
	if (json.data?.customerAddressCreate?.userErrors?.length) {
		console.error("Address create error:", json.data.customerAddressCreate.userErrors);
	}

	return json.data?.customerAddressCreate?.customerAddress || null;
}
