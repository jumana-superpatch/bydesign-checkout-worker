/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// export default {
// 	async fetch(request, env, ctx) {
// 		return new Response('Hello World!');
// 	},
// };


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
			if (url.pathname === "/lookup-checkout") {
				const email = url.searchParams.get("email");
				if (!email) {
					return jsonResponse({ error: "Missing email" }, 400);
				}

				try {
					console.log(`Looking up customer & rep for email: ${email}`);

					const [customerData, repValid] = await Promise.all([
						findCustomerInByDesign(email, env.BYDESIGN_BASE, env.BYDESIGN_API_KEY),
						validateRepEmail(email, env.BYDESIGN_BASE, env.BYDESIGN_API_KEY),
					]);

					const customer = customerData
						? { did: String(customerData.CustomerDID || "") }
						: null;

					const rep = { isRep: repValid };

					return jsonResponse({ customer, rep });
				} catch (err) {
					console.error("Parallel lookup failed:", err);
					return jsonResponse({ error: err.message }, 500);
				}
			}

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

async function validateRepEmail(email, base, apiKey) {
	const repRespXML = await fetch(
		`${base}/VoxxLife/api/rep/validateRepEmail?email=${encodeURIComponent(email)}`,
		{
			headers: {
				Authorization: `Basic ${apiKey}`,
				Accept: "application/xml",
			},
		}
	).then(r => r.text());

	// Parse <IsSuccessful>
	let isRep = false;
	const match = repRespXML.match(/<IsSuccessful>(.*?)<\/IsSuccessful>/);
	if (match) {
		const val = match[1].trim();
		// "False" means the email already exists in the system (rep/customer)
		isRep = val === "False";
	}

	return isRep;
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
