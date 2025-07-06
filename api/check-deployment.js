// api/check-deployment.js
import axios from 'axios';

export default async function handler(req, res) {
  try {
    const response = await axios.get('https://api.vercel.com/v6/deployments', {
      headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` }
    });
    const latestDeployment = response.data.deployments[0];
    const isSuccessful = latestDeployment.state === 'READY';
    res.status(200).json({ success: isSuccessful, error: isSuccessful ? null : 'Deployment not ready' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
