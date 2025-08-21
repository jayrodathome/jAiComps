// --- Helper functions for creating HTML elements ---

let usePlacesAPI = false;

/**
 * Creates a standard card element with a title.
 * @param {string} title - The title to display in an <h2> tag.
 * @returns {HTMLDivElement} The created card element.
 */
const createCard = (title) => {
  const card = document.createElement('div');
  card.className = 'card section';

  const cardTitle = document.createElement('h2');
  cardTitle.textContent = title;
  card.appendChild(cardTitle);

  return card;
};

/**
 * Creates a list of items from an array of objects with name and distance.
 * @param {Array<object>} items - Array of items, each with { name: string, distance_mi: number }.
 * @returns {string} A comma-separated string of items.
 */
const formatNamedList = (items) => {
  if (!items || items.length === 0) return 'N/A';
  return items.map(item => `${item.name} (${item.distance_mi} mi)`).join(', ');
};

async function getPlaceDetails(placeName, address, button) {
  button.disabled = true;
  button.textContent = 'Loading...';

  try {
    const response = await fetch('/api/getPlaceDetails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ placeName, address }),
    });

    if (!response.ok) {
      throw new Error(`Server error! Status: ${response.status}`);
    }

    const data = await response.json();

    const table = document.createElement('table');
    table.innerHTML = `
      <tr>
        <th>Distance</th>
        <th>Duration</th>
        <th>Direction</th>
        <th>Google Maps</th>
      </tr>
      <tr>
        <td>${data.distance}</td>
        <td>${data.duration}</td>
        <td>${data.direction}</td>
        <td><a href="${data.url}" target="_blank">View on Google Maps</a></td>
      </tr>
    `;

    button.parentNode.replaceChild(table, button);

  } catch (error) {
    console.error('Fetch error:', error);
    button.textContent = 'Error';
  }
}

/**
 * Renders all property data into the container.
 * @param {HTMLElement} container - The element to render the cards into.
 * @param {object} data - The full property details JSON object.
 */
const renderPropertyData = (container, data) => {
  // Clear any previous content
  container.innerHTML = '';

  // Generic function to render a section card
  const renderSection = (title, contentRenderer, sectionData) => {
    if (!sectionData) return;
    const card = createCard(title);
    const content = contentRenderer(sectionData);
    content.forEach(el => card.appendChild(el));
    container.appendChild(card);
  };

  // --- Render all sections using the data ---

  renderSection('Address', (d) => {
    const p = document.createElement('p');
    p.textContent = d;
    return [p];
  }, data.address);

  renderSection('Amenities Access', (d) => {
    const scoresDiv = document.createElement('div');
    scoresDiv.className = 'score-grid';
    scoresDiv.innerHTML = `
      <div class="score-box"><strong>Walk Score</strong><div class="score-value">${d.walk_score}</div></div>
      <div class="score-box"><strong>Transit Score</strong><div class="score-value">${d.transit_score}</div></div>
      <div class="score-box"><strong>Bike Score</strong><div class="score-value">${d.bike_score}</div></div>`;

    const ul = document.createElement('ul');
    const notable = d.notable_amenities;
    const amenityCategories = {
      "Supermarkets": notable.supermarkets,
      "Pharmacies": notable.pharmacies,
      "Hospitals": notable.hospitals,
      "Senior Centers": notable.senior_centers,
      "Shopping Districts": notable.shopping_business_districts,
      "Parks": notable.parks
    };

    for (const [category, items] of Object.entries(amenityCategories)) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${category}:</strong> ${formatNamedList(items)}`;
      ul.appendChild(li);
    }
    return [scoresDiv, ul];
  }, data.amenities_access);

  renderSection('Commute', (d) => {
    const transit = d.transit || {};
    const busAccess = document.createElement('p');
    busAccess.innerHTML = `<strong>Bus Access:</strong> ${transit.bus_access || 'N/A'}`;

    const majorRoutes = document.createElement('p');
    const routes = Array.isArray(transit.major_routes) ? transit.major_routes : [];
    majorRoutes.innerHTML = `<strong>Major Routes:</strong> ${routes.join(', ') || 'N/A'}`;

    const ul = document.createElement('ul');
    const driveTimes = (transit && transit.drive_times) || {};
    Object.entries(driveTimes).forEach(([key, details]) => {
      const prettyName = key
        .replace(/_/g, ' ')
        .replace(/\b(\w)/g, c => c.toUpperCase());
      const li = document.createElement('li');
      const dm = details && details.drive_min !== undefined ? details.drive_min : 'N/A';
      const mi = details && details.drive_mi !== undefined ? details.drive_mi : 'N/A';
      li.innerHTML = `<strong>${prettyName}:</strong> ${dm} min (${mi} mi)`;
      ul.appendChild(li);
    });
    return [busAccess, majorRoutes, ul];
  }, data.commute);

  renderSection('Schools', (d) => {
    const ul = document.createElement('ul');
    const schoolLevels = { "Elementary": d.elementary, "Middle": d.middle, "High": d.high };
    for (const [level, details] of Object.entries(schoolLevels)) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${level}:</strong> ${details.name} (${details.distance_mi} mi)`;
      if (usePlacesAPI) {
        const button = document.createElement('button');
        button.textContent = 'Get Details';
        button.addEventListener('click', () => getPlaceDetails(details.name, data.address, button));
        li.appendChild(button);
      }
      ul.appendChild(li);
    }
    return [ul];
  }, data.schools);

  renderSection('Crime', (d) => {
    const elements = [];
    if (d.context) {
      const context = document.createElement('p');
      context.textContent = d.context;
      elements.push(context);
    }
    if (d.trend) {
      const trend = document.createElement('p');
      trend.innerHTML = `<em>${d.trend}</em>`;
      elements.push(trend);
    }
    if (d.stats) {
      if (d.stats.note) {
        const note = document.createElement('p');
        note.innerHTML = `<em>${d.stats.note}</em>`;
        elements.push(note);
      } else {
        const heading = document.createElement('p');
        const loc = d.stats.level === 'city' && d.stats.city ? `${d.stats.city}, ${d.stats.state}` : d.stats.state;
        heading.innerHTML = `<strong>FBI Crime Data (${loc} – ${d.stats.year})</strong>`;
        if (d.stats.level === 'city' && d.stats.note) {
          const note = document.createElement('p');
          note.innerHTML = `<em>${d.stats.note}</em>`;
          elements.push(note);
        }
        elements.push(heading);
        const table = document.createElement('table');
        table.className = 'crime-table';
        const rows = [
          ['Violent Crime', d.stats.violent_crime, d.stats.violent_rate_per_100k],
          ['  Homicide', d.stats.homicide, null],
          ['  Robbery', d.stats.robbery, null],
          ['  Aggravated Assault', d.stats.aggravated_assault, null],
          ['Property Crime', d.stats.property_crime, d.stats.property_rate_per_100k],
          ['  Burglary', d.stats.burglary, d.stats.burglary_rate_per_100k],
            ['  Larceny', d.stats.larceny, d.stats.larceny_rate_per_100k],
          ['  Motor Vehicle Theft', d.stats.motor_vehicle_theft, d.stats.motor_vehicle_theft_rate_per_100k],
          ['Arson', d.stats.arson, d.stats.arson_rate_per_100k]
        ];
        table.innerHTML = `
          <thead><tr><th>Offense</th><th>Count</th><th>Rate / 100k</th></tr></thead>
          <tbody>
            ${rows.filter(r => r[1] !== undefined && r[1] !== null).map(r => `
              <tr>
                <td>${r[0]}</td>
                <td>${r[1] !== null && r[1] !== undefined ? r[1].toLocaleString() : '—'}</td>
                <td>${r[2] !== null && r[2] !== undefined ? r[2] : '—'}</td>
              </tr>`).join('')}
          </tbody>`;
        elements.push(table);
        const src = document.createElement('p');
        src.className = 'data-source';
        src.innerHTML = `<small>Source: FBI Crime Data Explorer (api.usa.gov) – State-level estimates. Rates computed per 100k population.</small>`;
        elements.push(src);
      }
    }
    return elements;
  }, data.crime);

  renderSection('Broadband', (d) => {
    const ul = document.createElement('ul');
    ul.innerHTML = `
      <li><strong>Cable:</strong> ${d.cable.provider} (Up to ${d.cable.max_speed_mbps} Mbps, ${d.cable.coverage_percent}% coverage)</li>
      <li><strong>Fiber:</strong> ${d.fiber.providers.join(', ')} (${d.fiber.availability})</li>
      <li><strong>5G Home:</strong> ${d["5g_home"].join(', ')}</li>
      <li><strong>Satellite:</strong> ${d.satellite.join(', ')}</li>`;
    const notes = document.createElement('p');
    notes.textContent = d.notes;
    return [ul, notes];
  }, data.broadband);

  renderSection('Environmental Risk', (d) => {
    const ul = document.createElement('ul');
    ul.innerHTML = `
      <li><strong>Flood Risk:</strong> ${d.flood_risk}</li>
      <li><strong>Fire Risk:</strong> ${d.fire_risk}</li>
      <li><strong>Heat Risk:</strong> ${d.heat_risk}</li>
      <li><strong>Air Quality:</strong> ${d.air_quality}</li>`;
    return [ul];
  }, data.environmental_risk);
};

/**
 * Main function to set up event listeners.
 */
const main = () => {
  const form = document.getElementById('address-form');
  const input = document.getElementById('address-input');
  const button = form.querySelector('button');
  const container = document.getElementById('property-list');
  const usePlacesApiCheckbox = document.getElementById('use-places-api');

  usePlacesApiCheckbox.addEventListener('change', () => {
    usePlacesAPI = usePlacesApiCheckbox.checked;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault(); // Prevent the form from reloading the page
    const address = input.value.trim();
    if (!address) return;

    // Disable the button and show a loading state
    button.disabled = true;
    button.textContent = 'Loading...';

    container.innerHTML = '<p>Loading property details...</p>';

    try {
      // Call our new backend server
      // Timeout handling
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      let response;
      try {
  response = await fetch('/api/getPropertyDetails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ address: address }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Server error! Status: ${response.status}`);
      }

      const data = await response.json();
      renderPropertyData(container, data);

    } catch (error) {
  const aborted = error.name === 'AbortError';
  container.innerHTML = `<div style="color: red;"><strong>Failed to load property details:</strong><br>${aborted ? 'Request timed out. Please try again.' : error.message}</div>`;
      console.error('Fetch error:', error);
    } finally {
      // Re-enable the button and restore its text when the operation is complete
      button.disabled = false;
      button.textContent = 'Get Details';
    }
  });
};

// Run the main script after the DOM has fully loaded.
document.addEventListener('DOMContentLoaded', main);
